import { AlertCircle, CheckCircle2, Globe2, LoaderCircle, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

type SearchDiagnostics = {
  provider?: string;
  status?: string;
  attempts?: number;
  elapsedMs?: number;
  fallback?: boolean;
  fallbackStatus?: string | null;
  fallbackAttempts?: number;
  fallbackElapsedMs?: number;
  error?: string;
  fallbackError?: string;
};

type FetchDiagnostics = {
  attempts?: number;
  contentType?: string;
  finalUrl?: string;
  truncated?: boolean;
  extractor?: string;
};

type SearchTestResult = {
  kind: 'search';
  query: string;
  tookMs: number;
  proxy: boolean;
  diagnostics?: SearchDiagnostics;
  results: SearchHit[];
};

type FetchTestResult = {
  kind: 'fetch';
  tookMs: number;
  proxy: boolean;
  diagnostics?: FetchDiagnostics;
  url: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
};

type DiagnosticItem = [label: string, value: string | number | boolean | null | undefined];

function ResultHeader({ tookMs, proxy }: { tookMs: number; proxy: boolean }) {
  return <div className="admin-tool-result-header" role="status">
    <CheckCircle2 size={15} strokeWidth={1.9} aria-hidden="true" />
    <span>调用成功</span>
    <span className="admin-tool-duration">耗时 {(tookMs / 1000).toFixed(2)} 秒</span>
    <span className="admin-tool-duration">{proxy ? '经上游代理' : '直连上游'}</span>
  </div>;
}

function Diagnostics({ items }: { items: DiagnosticItem[] }) {
  const visible = items.filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!visible.length) return null;
  return <dl className="admin-tool-diagnostics">
    {visible.map(([label, value]) => <div key={label}>
      <dt>{label}</dt>
      <dd>{typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}</dd>
    </div>)}
  </dl>;
}

function SearchDiagnosticsView({ diagnostics }: { diagnostics?: SearchDiagnostics }) {
  if (!diagnostics) return null;
  return <Diagnostics items={[
    ['主来源', diagnostics.provider],
    ['状态', diagnostics.status],
    ['尝试次数', diagnostics.attempts],
    ['主来源耗时', diagnostics.elapsedMs === undefined ? undefined : `${diagnostics.elapsedMs} ms`],
    ['回退 Bing', diagnostics.fallback],
    ['回退状态', diagnostics.fallbackStatus],
    ['回退尝试', diagnostics.fallbackAttempts],
    ['回退耗时', diagnostics.fallbackElapsedMs === undefined ? undefined : `${diagnostics.fallbackElapsedMs} ms`],
    ['主来源错误', diagnostics.error],
    ['回退错误', diagnostics.fallbackError],
  ]} />;
}

function FetchDiagnosticsView({ diagnostics }: { diagnostics?: FetchDiagnostics }) {
  if (!diagnostics) return null;
  return <Diagnostics items={[
    ['提取器', diagnostics.extractor],
    ['下载尝试', diagnostics.attempts],
    ['内容类型', diagnostics.contentType],
    ['最终地址', diagnostics.finalUrl],
    ['响应截断', diagnostics.truncated],
  ]} />;
}

function SearchResults({ result }: { result: SearchTestResult }) {
  if (!result.results.length) {
    return <p className="admin-tool-notice" role="status">
      服务已响应，但没有找到搜索结果。可以换一个关键词或检查代理与上游服务。
    </p>;
  }
  return <ol className="admin-tool-results">
    {result.results.map((item, index) => <li className="admin-tool-result" key={`${item.rank}:${item.url}`}>
      <a className="admin-tool-result-title" href={item.url} target="_blank" rel="noopener noreferrer">
        {index + 1}. {item.title}
      </a>
      <div className="admin-tool-result-meta">
        <span>{item.domain}</span>
        {item.engine && <span className="admin-badge">{item.engine}</span>}
      </div>
      <span className="admin-tool-result-url">{item.url}</span>
      {item.snippet && <p className="admin-tool-result-snippet">{item.snippet}</p>}
    </li>)}
  </ol>;
}

function FetchResult({ result }: { result: FetchTestResult }) {
  return <div className="admin-tool-fetch-result">
    <a className="admin-tool-result-title" href={result.url} target="_blank" rel="noopener noreferrer">
      {result.title || result.url}
    </a>
    <span className="admin-tool-result-url">{result.url}</span>
    <div className="admin-tool-result-meta">
      <span>{result.chars.toLocaleString('zh-CN')} 字符</span>
      {result.truncated && <span className="admin-badge is-warning">内容已截断</span>}
    </div>
    <pre className="admin-tool-text">{result.text}</pre>
  </div>;
}

function SearchTester({ request }: { request: Request }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchTestResult | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !query.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = await request<{ result: SearchTestResult }>('/api/admin/tools/test', {
        method: 'POST', body: JSON.stringify({ kind: 'search', query: query.trim() }),
      });
      setResult(payload.result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '搜索测试失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-panel" aria-labelledby="admin-search-test-heading">
    <header className="admin-panel-header">
      <div>
        <h2 id="admin-search-test-heading">Web Search · 网页搜索</h2>
        <p>使用与聊天相同的搜索服务，检查上游可访问性、结果数量与来源。</p>
      </div>
    </header>
    <form className="admin-tool-form" onSubmit={(event) => void submit(event)}>
      <label className="admin-search admin-tool-input">
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input aria-label="搜索内容" type="search" maxLength={500} placeholder="输入要搜索的内容"
          value={query} onChange={(event) => setQuery(event.target.value)} disabled={busy} />
      </label>
      <button className="primary-button" type="submit" disabled={busy || !query.trim()}>
        {busy && <LoaderCircle className="login-spinner" size={15} strokeWidth={2} aria-hidden="true" />}
        {busy ? '正在搜索…' : '测试搜索'}
      </button>
    </form>
    <div className="admin-tool-output" aria-live="polite">
      {error && <p className="admin-tool-error" role="alert">
        <AlertCircle size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>{error}</span>
      </p>}
      {result && <>
        <ResultHeader tookMs={result.tookMs} proxy={result.proxy} />
        <SearchDiagnosticsView diagnostics={result.diagnostics} />
        <SearchResults result={result} />
      </>}
    </div>
  </section>;
}

function FetchTester({ request }: { request: Request }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'fast' | 'full'>('fast');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchTestResult | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !url.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = await request<{ result: FetchTestResult }>('/api/admin/tools/test', {
        method: 'POST', body: JSON.stringify({ kind: 'fetch', url: url.trim(), mode }),
      });
      setResult(payload.result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '网页读取测试失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-panel" aria-labelledby="admin-fetch-test-heading">
    <header className="admin-panel-header">
      <div>
        <h2 id="admin-fetch-test-heading">Web Fetch · 网页读取</h2>
        <p>输入公网网页地址，检查代理、重定向校验和正文提取是否正常。</p>
      </div>
    </header>
    <form className="admin-tool-form" onSubmit={(event) => void submit(event)}>
      <label className="admin-search admin-tool-input">
        <Globe2 size={16} strokeWidth={1.75} aria-hidden="true" />
        <input aria-label="网页地址" type="url" maxLength={2000} placeholder="https://example.com/article"
          value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} />
      </label>
      <select className="text-field admin-tool-mode" aria-label="提取模式" value={mode} disabled={busy}
        onChange={(event) => setMode(event.target.value === 'full' ? 'full' : 'fast')}>
        <option value="fast">快速</option>
        <option value="full">完整</option>
      </select>
      <button className="primary-button" type="submit" disabled={busy || !url.trim()}>
        {busy && <LoaderCircle className="login-spinner" size={15} strokeWidth={2} aria-hidden="true" />}
        {busy ? '正在读取…' : '测试读取'}
      </button>
    </form>
    <div className="admin-tool-output" aria-live="polite">
      {error && <p className="admin-tool-error" role="alert">
        <AlertCircle size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>{error}</span>
      </p>}
      {result && <>
        <ResultHeader tookMs={result.tookMs} proxy={result.proxy} />
        <FetchDiagnosticsView diagnostics={result.diagnostics} />
        <FetchResult result={result} />
      </>}
    </div>
  </section>;
}

/** Admin-only smoke test for the two deployed web tools. It calls the live API rather than a
    mock so proxy, upstream and extraction problems surface before users hit them. */
export function AdminToolTest({ request }: { request: Request }) {
  return <div className="admin-tool-test">
    <div className="admin-page-heading">
      <div>
        <span className="eyebrow">WEB TOOLS</span>
        <h1>工具测试</h1>
        <p>测试使用当前 API 进程的真实配置和网络出口，与聊天中的联网工具走同一条链路。</p>
      </div>
    </div>
    <SearchTester request={request} />
    <FetchTester request={request} />
  </div>;
}
