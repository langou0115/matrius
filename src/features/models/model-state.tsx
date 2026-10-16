import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { flattenProviderModels, validateModelConfig, validateProviderConfig, type ModelConfig, type ProviderConfig, type ProviderModelConfig } from '@/core/llm/model-config';
import { createModelCredentials } from '@/core/platform/model-credentials';
import { loadModelPreferences, saveModelPreferences, type ModelPreferences } from './model-repository.web';

function useModelState(preview: boolean) {
  const [data, setData] = useState<ModelPreferences>({ providers: [], selectedId: null });
  const [ready, setReady] = useState(preview);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const credentials = useRef(createModelCredentials());
  const revision = useRef(0);
  const current = useRef(data);
  const queue = useRef(Promise.resolve());
  const models = useMemo(() => flattenProviderModels(data.providers), [data.providers]);

  useEffect(() => {
    let active = true;
    if (!preview) loadModelPreferences().then((loaded) => {
      if (!active) return;
      revision.current = loaded.revision; current.current = loaded.data;
      setData(loaded.data); setReady(true);
    }).catch(() => { if (active) setError('无法读取模型配置，请刷新后重试。'); });
    const vault = credentials.current;
    return () => { active = false; vault.clear(); };
  }, [preview]);

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
    });
    if (!valid.requiresApiKey) credentials.current.delete(valid.id);
    else if (apiKey.trim()) credentials.current.set(valid.id, apiKey);
    setVersion((value) => value + 1);
  }

  async function saveModel(providerId: string, value: ProviderModelConfig) {
    const provider = current.current.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error('找不到该服务商，请刷新后重试。');
    const valid = validateProviderConfig({
      ...provider,
      models: [...provider.models.filter((item) => item.id !== value.id), value],
    });
    await update({
      providers: current.current.providers.map((item) => item.id === providerId ? valid : item),
      selectedId: current.current.selectedId ?? value.id,
    });
  }

  async function removeModel(id: string) {
    const providers = current.current.providers.map((provider) => ({
      ...provider,
      models: provider.models.filter((item) => item.id !== id),
    }));
    const remainingModels = flattenProviderModels(providers);
    await update({ providers, selectedId: current.current.selectedId === id ? remainingModels[0]?.id ?? null : current.current.selectedId });
  }

  return {
    ...data, models, ready, error, version,
    selected: models.find((item) => item.id === data.selectedId),
    getKey: (providerId: string) => credentials.current.get(providerId),
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
          id: valid.id, name: valid.name, modelId: valid.modelId, contextWindow: valid.contextWindow, maxOutput: valid.maxOutput,
        }],
      });
      await update({
        providers: [...current.current.providers.filter((item) => item.id !== provider.id), provider],
        selectedId: current.current.selectedId ?? valid.id,
      });
      if (!provider.requiresApiKey) credentials.current.delete(provider.id);
      else if (apiKey.trim()) credentials.current.set(provider.id, apiKey);
      setVersion((value) => value + 1);
    },
    async select(id: string) {
      if (flattenProviderModels(current.current.providers).some((item) => item.id === id)) await update({ ...current.current, selectedId: id });
    },
    removeModel,
    async remove(id: string) { return removeModel(id); },
    async removeProvider(id: string) {
      const providers = current.current.providers.filter((item) => item.id !== id);
      const remainingModels = flattenProviderModels(providers);
      const removed = current.current.providers.find((item) => item.id === id);
      await update({ providers, selectedId: removed?.models.some((item) => item.id === current.current.selectedId) ? remainingModels[0]?.id ?? null : current.current.selectedId });
      credentials.current.delete(id);
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
