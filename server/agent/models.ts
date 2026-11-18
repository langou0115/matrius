import { validateBaseUrl, type CatalogModel, type ProviderProtocol } from '../../contract/agent-provider';
import { AppError, invalid } from '../errors';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ANTHROPIC_PAGES = 10;

export type FetchProviderModelsInput = {
  protocol: ProviderProtocol;
  baseUrl: string;
  requiresApiKey: boolean;
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

function getModelsUrlCandidates(baseUrl: string, protocol: ProviderProtocol): URL[] {
  const parsed = new URL(baseUrl);
  const normalized = parsed.toString().replace(/\/+$/u, '');
  if (normalized.endsWith('/v1')) {
    return [new URL(`${normalized}/models`)];
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    return [new URL(`${normalized}/v1/models`), new URL(`${normalized}/models`)];
  }
  // OpenAI SDK appends /models directly to baseUrl while Anthropic SDK appends /v1/messages.
  // Try the protocol's native shape first and fall back to the alternate path only on 404.
  return protocol === 'message'
    ? [new URL(`${normalized}/v1/models`), new URL(`${normalized}/models`)]
    : [new URL(`${normalized}/models`), new URL(`${normalized}/v1/models`)];
}

function getModelId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object' || value === null) return '';
  const item = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const candidate = item[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function getModelName(item: unknown, fallbackId: string): string {
  if (typeof item !== 'object' || item === null) return fallbackId;
  const record = item as Record<string, unknown>;
  for (const key of ['display_name', 'displayName', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallbackId;
}

function readModels(body: unknown): { models: CatalogModel[]; hasMore: boolean } {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined;
  const items = Array.isArray(body) ? body
    : record && Array.isArray(record.data) ? record.data
      : record && Array.isArray(record.models) ? record.models
        : [];
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = getModelId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: getModelName(item, id) });
  }
  return { models, hasMore: record?.has_more === true };
}

function getBearerToken(apiKey: string): string {
  const trimmed = apiKey.trim();
  return /^Bearer\s+/iu.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function buildHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const trimmed = apiKey.trim();
  if (!trimmed) return headers;
  if (protocol === 'message') {
    headers['x-api-key'] = trimmed;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = getBearerToken(trimmed);
  }
  return headers;
}

function buildPageUrl(baseModelsUrl: URL, protocol: ProviderProtocol, afterId: string): URL {
  const url = new URL(baseModelsUrl);
  if (protocol === 'message') {
    url.searchParams.set('limit', '1000');
    if (afterId) url.searchParams.set('after_id', afterId);
  }
  return url;
}

async function fetchPage(
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetcher(url, {
    method: 'GET',
    headers,
    cache: 'no-store',
    signal,
  });
  return response;
}

/**
 * Fetches available models from an upstream LLM provider directly from Node so
 * browser CORS restrictions never block discovery and API keys stay transient.
 */
export async function fetchProviderModels({
  protocol,
  baseUrl,
  requiresApiKey,
  apiKey = '',
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher = fetch,
}: FetchProviderModelsInput): Promise<CatalogModel[]> {
  let validatedBaseUrl: string;
  try {
    validatedBaseUrl = validateBaseUrl(baseUrl);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : '请输入完整的服务商 Base URL。');
  }

  if (requiresApiKey && !apiKey.trim()) {
    throw invalid('请先在服务商设置中填写 API key，再获取模型列表。');
  }

  const candidates = getModelsUrlCandidates(validatedBaseUrl, protocol);
  const headers = buildHeaders(protocol, apiKey);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  let afterId = '';
  let activeBaseUrl = candidates[0];

  try {
    for (let page = 0; page < MAX_ANTHROPIC_PAGES; page += 1) {
      let response = await fetchPage(fetcher, buildPageUrl(activeBaseUrl, protocol, afterId), headers, combinedSignal);

      // Only fall back to the alternate path shape on the first page when the primary returns 404.
      if (page === 0 && response.status === 404 && candidates.length > 1) {
        await response.body?.cancel().catch(() => {});
        activeBaseUrl = candidates[1];
        response = await fetchPage(fetcher, buildPageUrl(activeBaseUrl, protocol, afterId), headers, combinedSignal);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          throw new AppError(502, 'provider_auth_error', `Provider 返回 HTTP ${response.status}，请检查 API key 及权限。`);
        }
        throw new AppError(502, 'provider_error', `Provider 返回 HTTP ${response.status}，无法获取模型列表。`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AppError(502, 'provider_invalid_response', 'Provider 返回的模型目录不是有效 JSON。');
      }

      const result = readModels(body);
      for (const model of result.models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }

      if (protocol !== 'message' || !result.hasMore) break;
      const lastId = result.models.at(-1)?.id;
      if (!lastId || lastId === afterId) break;
      afterId = lastId;
    }
  } catch (reason) {
    if (reason instanceof AppError) throw reason;
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', '请求已取消。');
    if (timeoutController.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) {
      throw new AppError(504, 'provider_timeout', '获取模型列表超时，请检查服务商地址和网络。');
    }
    throw new AppError(502, 'provider_network_error', '无法连接服务商，请检查服务商地址和网络后重试，或手动添加模型。');
  } finally {
    clearTimeout(timer);
  }

  if (!models.length) {
    throw new AppError(502, 'provider_empty_catalog', '服务商没有返回可用模型，请检查权限或手动添加模型 ID。');
  }

  return models.sort((left, right) => left.name.localeCompare(right.name));
}
