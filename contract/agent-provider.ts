import type { Api, Model } from '@mariozechner/pi-ai';

import type { ModelConfig, ProviderProtocol, ThinkingEffort } from './agent-protocol';
import { isThinkingEffort } from './agent-thinking';

/**
 * Provider and model settings shared by the browser settings screens and the
 * server runtime. Validation runs on both sides on purpose: the client rejects a
 * bad form before saving, and the server re-validates whatever a run request
 * carries. `ModelConfig` itself is part of the wire contract, so it is declared
 * once in `agent-protocol.ts` and only re-exported here.
 */

export type { ModelConfig, ProviderProtocol };

export const protocols = [
  { id: 'completion', label: 'OpenAI Chat Completions', baseUrl: 'https://api.openai.com/v1' },
  { id: 'responses', label: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1' },
  { id: 'message', label: 'Anthropic Messages', baseUrl: 'https://api.anthropic.com' },
] as const satisfies readonly { id: ProviderProtocol; label: string; baseUrl: string }[];

/** One model as stored inside a provider record; the provider join is added by `flattenProviderModels`. */
export type ProviderModelConfig = Omit<ModelConfig, 'providerId' | 'providerName' | 'protocol' | 'baseUrl' | 'requiresApiKey'>;

export type ProviderConfig = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  requiresApiKey: boolean;
  models: ProviderModelConfig[];
};

export type CatalogModel = { id: string; name: string };

export function validateBaseUrl(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error('请输入完整的服务商 Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 只支持 HTTP(S)，不能包含实例、密码、查询参数或锚点。');
  }
  return url.toString().replace(/\/$/, '');
}

function validateModelValues(value: ProviderModelConfig): ProviderModelConfig {
  if (!value.id || !value.name.trim() || !value.modelId.trim()) throw new Error('请填写模型名称与模型 ID。');
  if (!Number.isSafeInteger(value.contextWindow) || !Number.isSafeInteger(value.maxOutput) || value.maxOutput < 1 || value.contextWindow <= value.maxOutput) {
    throw new Error('上下文窗口必须大于最大输出，且都为正整数。');
  }
  return {
    id: value.id,
    name: value.name.trim(),
    modelId: value.modelId.trim(),
    // Older records predate this flag: keep them text-only until the user opts in.
    supportsImage: value.supportsImage === true,
    contextWindow: value.contextWindow,
    maxOutput: value.maxOutput,
    thinkingEffort: isThinkingEffort(value.thinkingEffort) ? value.thinkingEffort : 'low',
  };
}

export function validateProviderConfig(value: ProviderConfig): ProviderConfig {
  if (!value.id || !value.name.trim()) throw new Error('请填写服务商名称。');
  if (!protocols.some((item) => item.id === value.protocol)) throw new Error('请选择支持的协议。');
  if (!Array.isArray(value.models)) throw new Error('服务商模型列表格式错误。');
  const models = value.models.map(validateModelValues);
  if (new Set(models.map((item) => item.id)).size !== models.length || new Set(models.map((item) => item.modelId)).size !== models.length) {
    throw new Error('同一服务商下不能重复添加模型。');
  }
  return {
    id: value.id,
    name: value.name.trim(),
    protocol: value.protocol,
    baseUrl: validateBaseUrl(value.baseUrl),
    requiresApiKey: value.requiresApiKey !== false,
    models,
  };
}

/**
 * Backward-compatible runtime normalizer for old, flat model settings.
 * Stored provider records use validateProviderConfig instead.
 */
export function validateModelConfig(value: ModelConfig | (ProviderModelConfig & Partial<Pick<ModelConfig, 'providerId' | 'providerName' | 'protocol' | 'baseUrl' | 'requiresApiKey'>>)): ModelConfig {
  const model = validateModelValues(value);
  const protocol = protocols.find((item) => item.id === value.protocol);
  if (!protocol) throw new Error('请选择支持的协议。');
  if (typeof value.baseUrl !== 'string') throw new Error('请输入完整的服务商 Base URL。');
  return {
    ...model,
    providerId: value.providerId || `legacy-${value.id}`,
    providerName: value.providerName?.trim() || value.name.trim(),
    protocol: protocol.id,
    baseUrl: validateBaseUrl(value.baseUrl),
    requiresApiKey: value.requiresApiKey !== false,
  };
}

export function flattenProviderModels(providers: ProviderConfig[]): ModelConfig[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({
    ...model,
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    requiresApiKey: provider.requiresApiKey,
  })));
}

/** Re-exported for callers that keep a thinking level next to a model. */
export type { ThinkingEffort };

const protocolToApi = { completion: 'openai-completions', responses: 'openai-responses', message: 'anthropic-messages' } as const;

/** Models are only built where requests originate: the server runtime. The browser
    sends model config per request to `/api/agent/*`, never builds a pi-ai model object. */
export function createAgentModel(config: ModelConfig): Model<Api> {
  return {
    api: protocolToApi[config.protocol], baseUrl: config.baseUrl,
    id: config.modelId, name: config.name, provider: `matrius-${config.providerId || config.id}`,
    reasoning: false, input: config.supportsImage ? ['text', 'image'] : ['text'], contextWindow: config.contextWindow, maxTokens: config.maxOutput,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(config.protocol === 'completion' ? { compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } } : {}),
  };
}
