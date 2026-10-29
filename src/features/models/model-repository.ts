import { readLocalValue, writeLocalValue } from '@/core/database/local-store';
import { EMPTY_MODEL_PREFERENCES, normalizePreferences, type LegacyModelPreferences, type ModelPreferences } from './model-preferences';

export type { LegacyModelPreferences, ModelPreferences } from './model-preferences';

const key = 'model-preferences';

export async function loadModelPreferences() {
  const stored = await readLocalValue(key);
  if (!stored) return { revision: 0, data: { ...EMPTY_MODEL_PREFERENCES } };
  if (!stored.value || typeof stored.value !== 'object') throw new Error('Invalid model preferences');
  return { revision: stored.revision, data: normalizePreferences(stored.value as ModelPreferences | LegacyModelPreferences) };
}

export function saveModelPreferences(value: ModelPreferences | LegacyModelPreferences, revision: number) {
  const normalized = normalizePreferences(value);
  return writeLocalValue(key, { providers: normalized.providers, selectedId: normalized.selectedId, titleModelId: normalized.titleModelId }, revision);
}
