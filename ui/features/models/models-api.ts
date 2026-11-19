import type { ProviderConfig } from '@contract/agent-provider';

export type ModelSettingsState = {
  providers: ProviderConfig[];
  selectedId: string | null;
  titleModelId: string | null;
  memoryModelId: string | null;
  configuredKeyProviderIds: string[];
  revision: number;
};

export type SaveModelSettingsInput = {
  baseRevision: number;
  providers: ProviderConfig[];
  selectedId: string | null;
  titleModelId: string | null;
  memoryModelId: string | null;
  apiKeys?: Record<string, string | null>;
};

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function fetchModelSettings(request: ApiRequest): Promise<ModelSettingsState> {
  return request<ModelSettingsState>('/api/models');
}

export function saveModelSettings(
  request: ApiRequest,
  input: SaveModelSettingsInput,
): Promise<ModelSettingsState> {
  return request<ModelSettingsState>('/api/models', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
