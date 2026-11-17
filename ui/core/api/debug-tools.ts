export type DebugSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

export type DebugToolError = {
  code: string;
  message: string;
};

export type DebugSearchProviderStatus = {
  name: 'duckduckgo' | 'bing';
  status: 'ok' | 'empty' | 'blocked' | 'timeout' | 'error' | 'skipped';
  attempts: number;
  count: number;
  error?: string;
};

export type DebugSearchResponse =
  | {
    ok: true;
    tool: 'search';
    tookMs: number;
    query: string;
    count: number;
    providers?: DebugSearchProviderStatus[];
    results: DebugSearchResultItem[];
  }
  | {
    ok: false;
    tool: 'search';
    tookMs: number;
    query?: string;
    providers?: DebugSearchProviderStatus[];
    error: DebugToolError;
  };

export type DebugFetchPage = {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  chars: number;
};

export type DebugFetchResponse =
  | {
    ok: true;
    tool: 'fetch';
    tookMs: number;
    page: DebugFetchPage;
  }
  | {
    ok: false;
    tool: 'fetch';
    tookMs: number;
    url?: string;
    error: DebugToolError;
  };

async function postDebugTool<T extends { ok: boolean }>(
  endpoint: string,
  payload: Record<string, unknown>,
  tool: 'search' | 'fetch',
): Promise<T> {
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null) as (T & { error?: DebugToolError }) | null;
    if (!response.ok) {
      return {
        ok: false,
        tool,
        tookMs: Math.max(0, Date.now() - startedAt),
        error: {
          code: body?.error?.code ?? `http_${response.status}`,
          message: body?.error?.message ?? `请求失败（HTTP ${response.status}）`,
        },
      } as unknown as T;
    }
    if (body) return body;
    return {
      ok: false,
      tool,
      tookMs: Math.max(0, Date.now() - startedAt),
      error: { code: 'invalid_response', message: '服务端返回了空响应。' },
    } as unknown as T;
  } catch (error) {
    return {
      ok: false,
      tool,
      tookMs: Math.max(0, Date.now() - startedAt),
      error: {
        code: 'network_error',
        message: error instanceof Error ? error.message : '网络请求失败。',
      },
    } as unknown as T;
  }
}

export function testSearchTool(query: string, limit = 10): Promise<DebugSearchResponse> {
  return postDebugTool<DebugSearchResponse>('/api/debug/tools/search', { query, limit }, 'search');
}

export function testFetchTool(url: string, mode: 'fast' | 'full' = 'fast'): Promise<DebugFetchResponse> {
  return postDebugTool<DebugFetchResponse>('/api/debug/tools/fetch', { url, mode }, 'fetch');
}
