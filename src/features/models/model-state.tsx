import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import type { ThinkingEffort } from '@agent/core/thinking-effort';
import { flattenProviderModels, validateModelConfig, validateProviderConfig, type ModelConfig, type ProviderConfig, type ProviderModelConfig } from '@/core/llm/model-config';
import { createModelCredentials, type CredentialVault } from '@/core/platform/model-credentials';
import { createStoredModelCredentials } from './model-credential-store';
import { loadModelPreferences, saveModelPreferences, type ModelPreferences } from './model-repository';

function useModelState(preview: boolean) {
  const [data, setData] = useState<ModelPreferences>({ providers: [], selectedId: null, titleModelId: null, memoryModelId: null });
  const [ready, setReady] = useState(preview);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Preview stays on the session vault: it must not read or write real credentials.
  const [vault] = useState<CredentialVault>(() => preview ? createModelCredentials() : createStoredModelCredentials());
  const revision = useRef(0);
  const current = useRef(data);
  const queue = useRef(Promise.resolve());
  const models = useMemo(() => flattenProviderModels(data.providers), [data.providers]);

  useEffect(() => {
    let active = true;
    if (!preview) Promise.all([loadModelPreferences(), vault.load()]).then(([loaded]) => {
      if (!active) return;
      revision.current = loaded.revision; current.current = loaded.data;
      setData(loaded.data); setReady(true);
    }).catch(() => { if (active) setError('无法读取模型配置，请刷新后重试。'); });
    return () => { active = false; };
  }, [preview, vault]);

  function update(next: ModelPreferences): Promise<void> {
    const operation = queue.current.then(async () => {
      if (!preview) revision.current = await saveModelPreferences(next, revision.current);
      current.current = next; setData(next); setError(null);
    });
    queue.current = operation.catch(() => {});
    return operation.catch(() => { throw new Error('模型配置未能保存，可能存在其他页面的修改。请刷新后重试。'); });
  }

  async function saveProvider(config: ProviderConfig, apiKey: string) {
    const existing = current.current.providers.find((item) => item.id === config.id);
    const valid = validateProviderConfig({ ...config, models: existing?.models ?? config.models });
    await update({
      providers: [...current.current.providers.filter((item) => item.id !== valid.id), valid],
      selectedId: current.current.selectedId ?? valid.models[0]?.id ?? null,
      titleModelId: current.current.titleModelId,
      memoryModelId: current.current.memoryModelId,
    });
    if (!valid.requiresApiKey) await vault.delete(valid.id);
    else if (apiKey.trim()) await vault.set(valid.id, apiKey);
    setVersion((value) => value + 1);
  }

  async function saveModel(providerId: string, value: ProviderModelConfig) {
    const provider = current.current.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error('找不到该服务商，请刷新后重试。');
    // The settings form does not edit thinking depth, so keep whatever the model last used.
    const existing = provider.models.find((item) => item.id === value.id);
    const next = { ...value, thinkingEffort: value.thinkingEffort ?? existing?.thinkingEffort };
    const valid = validateProviderConfig({
      ...provider,
      models: [...provider.models.filter((item) => item.id !== value.id), next],
    });
    await update({
      providers: current.current.providers.map((item) => item.id === providerId ? valid : item),
      selectedId: current.current.selectedId ?? value.id,
      titleModelId: current.current.titleModelId,
      memoryModelId: current.current.memoryModelId,
    });
  }

  async function removeModel(id: string) {
    const providers = current.current.providers.map((provider) => ({
      ...provider,
      models: provider.models.filter((item) => item.id !== id),
    }));
    const remainingModels = flattenProviderModels(providers);
    await update({
      providers,
      selectedId: current.current.selectedId === id ? remainingModels[0]?.id ?? null : current.current.selectedId,
      titleModelId: current.current.titleModelId === id ? null : current.current.titleModelId,
      memoryModelId: current.current.memoryModelId === id ? null : current.current.memoryModelId,
    });
  }

  return {
    ...data, models, ready, error, version,
    selected: models.find((item) => item.id === data.selectedId),
    titleModel: models.find((item) => item.id === data.titleModelId),
    memoryModel: models.find((item) => item.id === data.memoryModelId),
    getKey: (providerId: string) => vault.get(providerId),
    saveProvider,
    saveModel,
    async save(config: ModelConfig, apiKey: string) {
      // Keeps the previous flat save contract available to existing callers while all data is stored by provider.
      const valid = validateModelConfig(config);
      const existing = current.current.providers.find((item) => item.id === valid.providerId);
      const provider = validateProviderConfig({
        id: valid.providerId,
        name: valid.providerName,
        protocol: valid.protocol,
        baseUrl: valid.baseUrl,
        requiresApiKey: valid.requiresApiKey,
        models: [...(existing?.models ?? []).filter((item) => item.id !== valid.id), {
          id: valid.id, name: valid.name, modelId: valid.modelId, supportsImage: valid.supportsImage, contextWindow: valid.contextWindow, maxOutput: valid.maxOutput,
          thinkingEffort: valid.thinkingEffort,
        }],
      });
      await update({
        providers: [...current.current.providers.filter((item) => item.id !== provider.id), provider],
        selectedId: current.current.selectedId ?? valid.id,
        titleModelId: current.current.titleModelId,
        memoryModelId: current.current.memoryModelId,
      });
      if (!provider.requiresApiKey) await vault.delete(provider.id);
      else if (apiKey.trim()) await vault.set(provider.id, apiKey);
      setVersion((value) => value + 1);
    },
    async select(id: string) {
      if (flattenProviderModels(current.current.providers).some((item) => item.id === id)) await update({ ...current.current, selectedId: id });
    },
    /** `null` follows the conversation's bound model; a title request never changes it. */
    async setTitleModelId(id: string | null) {
      if (id !== null && !flattenProviderModels(current.current.providers).some((item) => item.id === id)) return;
      if (current.current.titleModelId === id) return;
      await update({ ...current.current, titleModelId: id });
    },
    /** `null` follows the conversation's bound model, matching the memory assistant's default. */
    async setMemoryModelId(id: string | null) {
      if (id !== null && !flattenProviderModels(current.current.providers).some((item) => item.id === id)) return;
      if (current.current.memoryModelId === id) return;
      await update({ ...current.current, memoryModelId: id });
    },
    /** Each model keeps its own thinking depth, so switching models restores what that model last used. */
    async setThinkingEffort(id: string, thinkingEffort: ThinkingEffort) {
      if (flattenProviderModels(current.current.providers).find((item) => item.id === id)?.thinkingEffort === thinkingEffort) return;
      await update({
        ...current.current,
        providers: current.current.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => model.id === id ? { ...model, thinkingEffort } : model),
        })),
      });
    },
    removeModel,
    async remove(id: string) { return removeModel(id); },
    async removeProvider(id: string) {
      const providers = current.current.providers.filter((item) => item.id !== id);
      const remainingModels = flattenProviderModels(providers);
      const removed = current.current.providers.find((item) => item.id === id);
      await update({
        providers,
        selectedId: removed?.models.some((item) => item.id === current.current.selectedId) ? remainingModels[0]?.id ?? null : current.current.selectedId,
        titleModelId: removed?.models.some((item) => item.id === current.current.titleModelId) ? null : current.current.titleModelId,
        memoryModelId: removed?.models.some((item) => item.id === current.current.memoryModelId) ? null : current.current.memoryModelId,
      });
      await vault.delete(id);
      setVersion((value) => value + 1);
    },
  };
}

const ModelContext = createContext<ReturnType<typeof useModelState> | null>(null);
export function ModelProvider({ preview, children }: PropsWithChildren<{ preview: boolean }>) {
  return <ModelContext value={useModelState(preview)}>{children}</ModelContext>;
}
export function useModels() {
  const value = useContext(ModelContext);
  if (!value) throw new Error('ModelProvider is required');
  return value;
}
