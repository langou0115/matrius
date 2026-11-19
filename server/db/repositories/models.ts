import {
  flattenProviderModels,
  validateProviderConfig,
  type ProviderConfig,
} from '../../../contract/agent-provider';
import { conflict, invalid } from '../../errors';
import { toDbTimestamp } from '../codecs';
import type { AppDatabase } from '../client';

export type ModelConfigRow = {
  instance_id: number;
  providers_json: string;
  credentials_json: string;
  selected_id: string | null;
  title_model_id: string | null;
  memory_model_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ModelSettingsView = {
  providers: ProviderConfig[];
  selectedId: string | null;
  titleModelId: string | null;
  memoryModelId: string | null;
  configuredKeyProviderIds: string[];
  revision: number;
};

export type UpdateModelSettingsInput = {
  baseRevision: number;
  providers: ProviderConfig[];
  selectedId: string | null;
  titleModelId: string | null;
  memoryModelId: string | null;
  apiKeys?: Record<string, string | null>;
};

function modelConfigRow(db: AppDatabase, instanceId: number): ModelConfigRow | undefined {
  return db.prepare('SELECT * FROM model_configs WHERE instance_id = ?').get(instanceId) as
    | ModelConfigRow
    | undefined;
}

function parseJsonRecord<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseCredentials(raw: string): Record<string, string> {
  const parsed = parseJsonRecord<unknown>(raw, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === 'string' && key.trim()) result[id] = key.trim();
  }
  return result;
}

function normalizeProviders(rawProviders: unknown): ProviderConfig[] {
  if (!Array.isArray(rawProviders)) throw invalid('模型配置格式无效。');
  const validated = rawProviders.map((item) => {
    try {
      return validateProviderConfig(item as ProviderConfig);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : '服务商配置不合法。');
    }
  });
  const providerIds = validated.map((item) => item.id);
  if (new Set(providerIds).size !== providerIds.length) {
    throw invalid('服务商 ID 不能重复。');
  }
  const modelIds = flattenProviderModels(validated).map((item) => item.id);
  if (new Set(modelIds).size !== modelIds.length) {
    throw invalid('模型 ID 不能重复。');
  }
  return validated;
}

function toView(row: ModelConfigRow): ModelSettingsView {
  const parsedProviders = parseJsonRecord<unknown[]>(row.providers_json, []);
  const providers = Array.isArray(parsedProviders)
    ? parsedProviders.flatMap((item) => {
      try {
        return [validateProviderConfig(item as ProviderConfig)];
      } catch {
        return [];
      }
    })
    : [];
  const models = flattenProviderModels(providers);
  const credentials = parseCredentials(row.credentials_json);
  const configuredKeyProviderIds = providers
    .filter((provider) => provider.requiresApiKey && Boolean(credentials[provider.id]))
    .map((provider) => provider.id);

  return {
    providers,
    selectedId: row.selected_id && models.some((item) => item.id === row.selected_id)
      ? row.selected_id
      : models[0]?.id ?? null,
    titleModelId: row.title_model_id && models.some((item) => item.id === row.title_model_id)
      ? row.title_model_id
      : null,
    memoryModelId: row.memory_model_id && models.some((item) => item.id === row.memory_model_id)
      ? row.memory_model_id
      : null,
    configuredKeyProviderIds,
    revision: row.revision,
  };
}

export function getOrCreateModelConfigRow(db: AppDatabase, instanceId: number): ModelConfigRow {
  const existing = modelConfigRow(db, instanceId);
  if (existing) return existing;
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO model_configs
     (instance_id, providers_json, credentials_json, selected_id, title_model_id, memory_model_id, revision, created_at, updated_at)
     VALUES (?, '[]', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  ).run(instanceId, now, now);
  const created = modelConfigRow(db, instanceId);
  if (!created) throw new Error('Failed to load model_configs after insert.');
  return created;
}

export function getOrCreateModelSettings(db: AppDatabase, instanceId: number): ModelSettingsView {
  return toView(getOrCreateModelConfigRow(db, instanceId));
}

export function updateModelSettings(
  db: AppDatabase,
  instanceId: number,
  input: UpdateModelSettingsInput,
): ModelSettingsView {
  const current = getOrCreateModelConfigRow(db, instanceId);
  if (current.revision !== input.baseRevision) {
    throw conflict('模型配置已在其他页面更新，请刷新后重试。', toView(current));
  }

  const providers = normalizeProviders(input.providers);
  const models = flattenProviderModels(providers);
  const selectedId = input.selectedId && models.some((item) => item.id === input.selectedId)
    ? input.selectedId
    : models[0]?.id ?? null;
  const titleModelId = input.titleModelId && models.some((item) => item.id === input.titleModelId)
    ? input.titleModelId
    : null;
  const memoryModelId = input.memoryModelId && models.some((item) => item.id === input.memoryModelId)
    ? input.memoryModelId
    : null;

  const existingCredentials = parseCredentials(current.credentials_json);
  const nextCredentials: Record<string, string> = {};
  for (const provider of providers) {
    if (!provider.requiresApiKey) continue;
    if (input.apiKeys && Object.hasOwn(input.apiKeys, provider.id)) {
      const value = input.apiKeys[provider.id];
      if (typeof value === 'string' && value.trim()) {
        nextCredentials[provider.id] = value.trim();
      }
      continue;
    }
    if (existingCredentials[provider.id]) {
      nextCredentials[provider.id] = existingCredentials[provider.id];
    }
  }

  db.prepare(
    `UPDATE model_configs
     SET providers_json = ?, credentials_json = ?, selected_id = ?, title_model_id = ?, memory_model_id = ?,
         revision = revision + 1, updated_at = ?
     WHERE instance_id = ?`,
  ).run(
    JSON.stringify(providers),
    JSON.stringify(nextCredentials),
    selectedId,
    titleModelId,
    memoryModelId,
    toDbTimestamp(),
    instanceId,
  );

  const updated = modelConfigRow(db, instanceId);
  if (!updated) throw new Error('Failed to load model_configs after update.');
  return toView(updated);
}

export function getProviderApiKey(db: AppDatabase, instanceId: number, providerId: string): string {
  const row = modelConfigRow(db, instanceId);
  if (!row) return '';
  const credentials = parseCredentials(row.credentials_json);
  return credentials[providerId] ?? '';
}
