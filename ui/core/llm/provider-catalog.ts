import { validateBaseUrl, type CatalogModel, type ProviderConfig } from '@contract/agent-provider';

export type { CatalogModel };

const CLIENT_TIMEOUT_MS = 15_000;

export async function fetchProviderCatalog(
  provider: Pick<ProviderConfig, 'baseUrl' | 'protocol' | 'requiresApiKey'>,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CatalogModel[]> {
  const baseUrl = validateBaseUrl(provider.baseUrl);
  const trimmedKey = apiKey.trim();
  if (provider.requiresApiKey && !trimmedKey) {
    throw new Error('请先在服务商设置中填写 API key，再获取模型列表。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetcher('/api/agent/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        protocol: provider.protocol,
        baseUrl,
        requiresApiKey: provider.requiresApiKey,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      }),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) {
        throw new Error(`服务器返回 HTTP ${response.status}，无法获取模型列表。`);
      }
      throw new Error('服务器返回的模型列表格式无效。');
    }

    if (!response.ok) {
      const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
      throw new Error(typeof message === 'string' && message.trim()
        ? message
        : `服务器返回 HTTP ${response.status}，无法获取模型列表。`);
    }

    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || !models.length) {
      throw new Error('服务商没有返回可用模型，请检查权限或手动添加模型 ID。');
    }
    return models as CatalogModel[];
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') {
      throw new Error('获取模型列表超时，请检查服务商地址和网络。');
    }
    if (reason instanceof TypeError) {
      throw new Error('无法连接本站服务器，请检查服务状态后重试，或手动添加模型。');
    }
    throw reason;
  } finally {
    clearTimeout(timeout);
  }
}
