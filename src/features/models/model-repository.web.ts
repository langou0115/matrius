import { readLocalValue, writeLocalValue } from '@/core/database/browser-store.web';
import { flattenProviderModels, validateModelConfig, validateProviderConfig, type ModelConfig, type ProviderConfig } from '@/core/llm/model-config';

export type ModelPreferences = { providers: ProviderConfig[]; selectedId: string | null };
type LegacyModelPreferences = { models: ModelConfig[]; selectedId: string | null };
const key = 'model-preferences';

function normalizePreferences(value: ModelPreferences | LegacyModelPreferences): ModelPreferences {
  let providers: ProviderConfig[];

  if (Array.isArray((value as ModelPreferences).providers)) {
    providers = (value as ModelPreferences).providers.map(validateProviderConfig);
  } else if (Array.isArray((value as LegacyModelPreferences).models)) {
    // Upgrade old flat entries by grouping models that share a protocol and endpoint.
    // No credentials were persisted in the old format, so the migration carries metadata only.
    const grouped = new Map<string, ProviderConfig>();
    for (const oldModel of (value as LegacyModelPreferences).models) {
      const model = validateModelConfig(oldModel);
      const groupKey = `${model.protocol}\u0000${model.baseUrl}\u0000${model.requiresApiKey}`;
      let provider = grouped.get(groupKey);
      if (!provider) {
        let providerName = model.providerName;
        try { providerName = new URL(model.baseUrl).hostname || providerName; } catch { /* validated above */ }
        provider = {
          id: model.providerId,
          name: providerName,
          protocol: model.protocol,
          baseUrl: model.baseUrl,
          requiresApiKey: model.requiresApiKey,
          models: [],
        };
        grouped.set(groupKey, provider);
      }
      provider.models.push({
        id: model.id,
        name: model.name,
        modelId: model.modelId,
        supportsImage: model.supportsImage,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
      });
    }
    providers = [...grouped.values()].map(validateProviderConfig);
  } else {
    throw new Error('Invalid model preferences');
  }

  const models = flattenProviderModels(providers);
  if (new Set(providers.map((item) => item.id)).size !== providers.length) throw new Error('Duplicate provider IDs');
  if (new Set(models.map((item) => item.id)).size !== models.length) throw new Error('Duplicate model IDs');
  return {
    providers,
    selectedId: models.some((item) => item.id === value.selectedId) ? value.selectedId : models[0]?.id ?? null,
  };
}

export async function loadModelPreferences() {
  const stored = await readLocalValue(key);
  if (!stored) return { revision: 0, data: { providers: [], selectedId: null } as ModelPreferences };
  if (!stored.value || typeof stored.value !== 'object') throw new Error('Invalid model preferences');
  return { revision: stored.revision, data: normalizePreferences(stored.value as ModelPreferences | LegacyModelPreferences) };
}

export function saveModelPreferences(value: ModelPreferences | LegacyModelPreferences, revision: number) {
  const normalized = normalizePreferences(value);
  return writeLocalValue(key, { providers: normalized.providers, selectedId: normalized.selectedId }, revision);
}
