import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import {
  testFetchTool,
  testSearchTool,
  type DebugFetchResponse,
  type DebugSearchProviderStatus,
  type DebugSearchResponse,
  type DebugSearchResultItem,
} from '@/core/api/debug-tools';

type ToolStatus = 'idle' | 'running' | 'ok' | 'error';

const ENGINE_LABELS: Record<string, string> = {
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  official: '官网直连',
};

const PROVIDER_STATUS_LABELS: Record<DebugSearchProviderStatus['status'], string> = {
  ok: '成功',
  empty: '无结果',
  blocked: '被拦截',
  timeout: '超时',
  error: '失败',
  skipped: '已熔断跳过',
};

function parseEngines(raw: string): string[] {
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))]
    .map((engine) => ENGINE_LABELS[engine] ?? engine);
}

function summarizeEngines(results: readonly DebugSearchResultItem[]): string[] {
  const seen = new Set<string>();
  for (const item of results) {
    for (const label of parseEngines(item.engine)) seen.add(label);
  }
  return [...seen];
}

function ProviderBreakdown({ providers }: { providers?: DebugSearchProviderStatus[] }) {
  if (!providers?.length) return null;
  return (
    <div className="debug-provider-list" aria-label="搜索引擎尝试情况">
      {providers.map((provider) => (
        <span
          key={provider.name}
          className={`debug-provider-pill is-${provider.status === 'ok' ? 'ok' : provider.status === 'empty' ? 'muted' : 'warn'}`}
          title={provider.error}
        >
          <strong>{ENGINE_LABELS[provider.name] ?? provider.name}</strong>
          <span>
            {PROVIDER_STATUS_LABELS[provider.status]}
            {provider.status === 'ok' ? `（${provider.count} 条）` : provider.error ? `：${provider.error}` : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ status, tookMs }: { status: ToolStatus; tookMs?: number }) {
  const label = status === 'idle' ? '未测试'
    : status === 'running' ? '测试中…'
      : status === 'ok' ? `正常${tookMs !== undefined ? ` · ${tookMs} ms` : ''}`
        : `异常${tookMs !== undefined ? ` · ${tookMs} ms` : ''}`;
  return <span className={`debug-status-badge is-${status}`}>{label}</span>;
}

function ToolCard({
  id,
  title,
  icon,
  status,
  tookMs,
  children,
}: {
  id: string;
  title: string;
  icon: IconName;
  status: ToolStatus;
  tookMs?: number;
  children: ReactNode;
}) {
  return (
    <article className="debug-tool-card" aria-labelledby={`debug-tool-${id}`}>
      <div className="debug-tool-header">
        <span className="mock-card-icon"><Icon name={icon} size={20} /></span>
        <div className="debug-tool-title">
          <div className="debug-tool-title-row">
            <h3 id={`debug-tool-${id}`}>{title}</h3>
            <code className="debug-tool-id">{id}</code>
          </div>
        </div>
        <StatusBadge status={status} tookMs={tookMs} />
      </div>
      {children}
    </article>
  );
}

export function ToolsPanel() {
  const [query, setQuery] = useState('Node.js');
  const [searchStatus, setSearchStatus] = useState<ToolStatus>('idle');
  const [searchResult, setSearchResult] = useState<DebugSearchResponse | null>(null);

  const [url, setUrl] = useState('https://example.com');
  const [fetchMode, setFetchMode] = useState<'fast' | 'full'>('fast');
  const [fetchStatus, setFetchStatus] = useState<ToolStatus>('idle');
  const [fetchResult, setFetchResult] = useState<DebugFetchResponse | null>(null);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearchStatus('running');
    const result = await testSearchTool(trimmed);
    setSearchResult(result);
    setSearchStatus(result.ok ? 'ok' : 'error');
  }

  async function runFetch() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetchStatus('running');
    const result = await testFetchTool(trimmed, fetchMode);
    setFetchResult(result);
    setFetchStatus(result.ok ? 'ok' : 'error');
  }

  async function runAll() {
    await Promise.all([runSearch(), runFetch()]);
  }

  const anyRunning = searchStatus === 'running' || fetchStatus === 'running';

  return (
    <section className="settings-section" aria-labelledby="debug-tools-heading">
      <div className="debug-section-bar">
        <h2 id="debug-tools-heading">工具连通性测试</h2>
        <button
          type="button"
          className="debug-run-all-btn"
          disabled={anyRunning}
          onClick={() => { void runAll(); }}
        >
          <Icon name="refresh" size={15} />
          <span>{anyRunning ? '测试中…' : '全部测试'}</span>
        </button>
      </div>

      <div className="debug-tool-list">
        <ToolCard
          id="web_search"
          title="Search 工具"
          icon="search"
          status={searchStatus}
          tookMs={searchResult?.tookMs}
        >
          <form
            className="debug-tool-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="text"
              className="debug-tool-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入搜索关键词"
              aria-label="搜索关键词"
            />
            <button
              type="submit"
              className="debug-tool-btn"
              disabled={searchStatus === 'running' || !query.trim()}
            >
              {searchStatus === 'running' ? '测试中…' : '测试 Search'}
            </button>
          </form>

          {searchResult && (
            <div className="debug-tool-result">
              <ProviderBreakdown providers={searchResult.providers} />
              {searchResult.ok ? (
                <>
                  <p className="debug-result-meta">
                    搜索引擎：{summarizeEngines(searchResult.results).join('、') || '无'} · 返回 {searchResult.count} 条结果 · 耗时 {searchResult.tookMs} ms
                  </p>
                  {searchResult.results.length > 0 ? (
                    <ul className="debug-search-results">
                      {searchResult.results.map((item) => {
                        const engines = parseEngines(item.engine);
                        return (
                          <li key={`${item.rank}-${item.url}`}>
                            <div className="debug-search-item-head">
                              <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>
                              <span className="debug-engine-tags">
                                {engines.map((label) => (
                                  <span key={label} className="debug-engine-tag">{label}</span>
                                ))}
                              </span>
                            </div>
                            <span className="debug-result-sub">{item.domain}</span>
                            {item.snippet && <p>{item.snippet}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="debug-result-empty">接口调用成功，但未返回匹配结果。</p>
                  )}
                </>
              ) : (
                <div className="debug-result-error" role="alert">
                  <strong>{searchResult.error.code}</strong>
                  <span>{searchResult.error.message}</span>
                </div>
              )}
            </div>
          )}
        </ToolCard>

        <ToolCard
          id="web_fetch"
          title="Fetch 工具"
          icon="bolt"
          status={fetchStatus}
          tookMs={fetchResult?.tookMs}
        >
          <form
            className="debug-tool-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runFetch();
            }}
          >
            <input
              type="url"
              className="debug-tool-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="输入 http:// 或 https:// 网页地址"
              aria-label="网页地址"
            />
            <div className="debug-mode-switch" role="group" aria-label="抓取模式">
              {(['fast', 'full'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={fetchMode === mode}
                  onClick={() => setFetchMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              type="submit"
              className="debug-tool-btn"
              disabled={fetchStatus === 'running' || !url.trim()}
            >
              {fetchStatus === 'running' ? '测试中…' : '测试 Fetch'}
            </button>
          </form>

          {fetchResult && (
            <div className="debug-tool-result">
              {fetchResult.ok ? (
                <>
                  <p className="debug-result-meta">
                    标题：{fetchResult.page.title || '（无标题）'} · {fetchResult.page.chars} 字符
                    {fetchResult.page.truncated ? '（已截断）' : ''} · {fetchResult.tookMs} ms
                  </p>
                  <p className="debug-result-sub">{fetchResult.page.url}</p>
                  <pre className="debug-fetch-preview">{fetchResult.page.text}</pre>
                </>
              ) : (
                <div className="debug-result-error" role="alert">
                  <strong>{fetchResult.error.code}</strong>
                  <span>{fetchResult.error.message}</span>
                </div>
              )}
            </div>
          )}
        </ToolCard>
      </div>
    </section>
  );
}
