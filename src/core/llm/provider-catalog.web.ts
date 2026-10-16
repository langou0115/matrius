import type { ProviderConfig } from './model-config';

export type CatalogModel = { id: string; name: string };

function getModelsUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/u, '');
  const versionedBase = normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  return new URL(`${versionedBase}/models`);
}

function getModelId(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object' || value === null) return '';
  const item = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const candidate = item[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
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
    const name = typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).display_name === 'string'
      ? String((item as Record<string, unknown>).display_name).trim()
      : id;
    models.push({ id, name: name || id });
  }
  return { models, hasMore: record?.has_more === true };
}

function getBearerToken(apiKey: string) {
  const trimmed = apiKey.trim();
  return /^Bearer\s+/iu.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export async function fetchProviderCatalog(provider: Pick<ProviderConfig, 'baseUrl' | 'protocol' | 'requiresApiKey'>, apiKey: string): Promise<CatalogModel[]> {
  if (provider.requiresApiKey && !apiKey.trim()) throw new Error('请先在服务商设置中填写 API key，再获取模型列表。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.trim()) {
    if (provider.protocol === 'message') {
      headers['x-api-key'] = apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
      // Anthropic requires an explicit opt-in for requests made from browser JavaScript.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      headers.Authorization = getBearerToken(apiKey);
    }
  }

  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  let afterId = '';
  try {
    // OpenStudio uses the same /v1/models discovery shape. Anthropic's catalog is paginated;
    // request the largest page and continue with its documented cursor when needed.
    for (let page = 0; page < 10; page += 1) {
      const url = getModelsUrl(provider.baseUrl);
      if (provider.protocol === 'message') {
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);
      }
      const response = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error(`Provider 返回 HTTP ${response.status}，请检查 API key 及权限。`);
        throw new Error(`Provider 返回 HTTP ${response.status}，无法获取模型列表。`);
      }

      let body: unknown;
      try { body = await response.json(); }
      catch { throw new Error('Provider 返回的模型目录不是有效 JSON。'); }
      const result = readModels(body);
      for (const model of result.models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }

      if (provider.protocol !== 'message' || !result.hasMore) break;
      const lastId = result.models.at(-1)?.id;
      if (!lastId || lastId === afterId) break;
      afterId = lastId;
    }
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') throw new Error('获取模型列表超时，请检查服务商地址和网络。');
    if (reason instanceof TypeError) throw new Error('无法连接服务商。浏览器 CORS 可能阻止了模型目录请求；也可以手动添加模型。');
    throw reason;
  } finally {
    clearTimeout(timeout);
  }

  if (!models.length) throw new Error('服务商没有返回可用模型，请检查权限或手动添加模型 ID。');
  return models.sort((left, right) => left.name.localeCompare(right.name));
}
