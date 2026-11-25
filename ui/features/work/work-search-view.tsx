import type { WorkContentSearchResponse, WorkProject } from '@contract/work-projects';
import { ChevronRight, LoaderCircle, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { searchWorkProjectContent } from './work-api';
import { revealWorkFileLine } from './work-state';

function createPreviewContentSearch(project: WorkProject, query: string): WorkContentSearchResponse {
  const q = query.trim().toLowerCase();
  if (!q) return { files: [], totalMatches: 0, truncated: false };
  const samples = [
    { rel: 'README.md', name: 'README.md', line: 1, text: '# Matrius' },
    { rel: 'README.md', name: 'README.md', line: 3, text: 'React and TypeScript workspace.' },
    { rel: 'ui/main.tsx', name: 'main.tsx', line: 2, text: '  return <main>Matrius</main>;' },
    { rel: 'package.json', name: 'package.json', line: 2, text: '  "name": "matrius",' },
  ];
  const byRel = new Map<string, WorkContentSearchResponse['files'][number]>();
  let totalMatches = 0;
  for (const sample of samples) {
    const idx = sample.text.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    let file = byRel.get(sample.rel);
    if (!file) {
      file = {
        path: `${project.directory.replace(/[\\/]+$/u, '')}/${sample.rel}`,
        relativePath: sample.rel,
        name: sample.name,
        matches: [],
      };
      byRel.set(sample.rel, file);
    }
    file.matches.push({ line: sample.line, column: idx + 1, matchLength: query.trim().length, text: sample.text });
    totalMatches += 1;
  }
  return { files: Array.from(byRel.values()), totalMatches, truncated: false };
}

function renderHighlightedLine(text: string, column: number, matchLength: number) {
  const start = Math.max(0, Math.min(text.length, column - 1));
  const end = Math.max(start, Math.min(text.length, start + Math.max(1, matchLength)));
  return (
    <>
      {text.slice(0, start)}
      <mark className="work-search-highlight">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

export function WorkSearchView({ project }: { project: WorkProject }) {
  const { request } = useInstance();
  const preview = useIsPreview();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkContentSearchResponse | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    inputRef.current?.focus();
  }, [project.id]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (preview) {
      setResult(createPreviewContentSearch(project, trimmed));
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void searchWorkProjectContent(
        request,
        project.id,
        {
          query: trimmed,
          caseSensitive,
          regex,
          ...(include.trim() ? { include: include.trim() } : {}),
          ...(exclude.trim() ? { exclude: exclude.trim() } : {}),
        },
        controller.signal,
      ).then((data) => {
        if (controller.signal.aborted) return;
        setResult(data);
        setLoading(false);
      }, (reason: unknown) => {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(reason instanceof Error && reason.message ? reason.message : '项目查找失败。');
        setLoading(false);
      });
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [caseSensitive, exclude, include, preview, project, query, regex, request]);

  return (
    <section className="work-search-view" aria-label={`在 ${project.name} 中查找`}>
      <header className="work-search-header">
        <div className="work-search-bar">
          <div className="work-search-input-wrap">
            <Search size={16} strokeWidth={1.75} className="work-search-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className="work-search-input"
              placeholder={`在 ${project.name} 中查找内容…`}
              aria-label="项目内全局查找"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="work-cm-search-btn"
                aria-label="清空查找"
                onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <div className="work-cm-search-flags">
              <button
                type="button"
                className={`work-cm-search-flag${caseSensitive ? ' is-active' : ''}`}
                aria-pressed={caseSensitive}
                aria-label="区分大小写"
                title="区分大小写"
                onClick={() => setCaseSensitive((v) => !v)}
              >
                Aa
              </button>
              <button
                type="button"
                className={`work-cm-search-flag${regex ? ' is-active' : ''}`}
                aria-pressed={regex}
                aria-label="使用正则表达式"
                title="使用正则表达式"
                onClick={() => setRegex((v) => !v)}
              >
                .*
              </button>
            </div>
          </div>
          <button
            type="button"
            className={`icon-button work-search-filter-toggle${showFilters ? ' is-active' : ''}`}
            aria-label="文件过滤条件"
            aria-expanded={showFilters}
            title="包含 / 排除文件"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        {showFilters && (
          <div className="work-search-filters">
            <label className="work-search-filter-field">
              <span>包含文件</span>
              <input
                type="text"
                className="text-field"
                placeholder="例如：*.ts, ui/**"
                value={include}
                onChange={(event) => setInclude(event.target.value)}
              />
            </label>
            <label className="work-search-filter-field">
              <span>排除文件</span>
              <input
                type="text"
                className="text-field"
                placeholder="例如：*.test.*, dist/**"
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
              />
            </label>
          </div>
        )}

        {(loading || error || result) && (
          <div className="work-search-summary" role="status">
            {loading ? (
              <span className="work-search-loading">
                <LoaderCircle size={13} strokeWidth={1.75} className="loading-spinner" aria-hidden="true" />
                正在查找…
              </span>
            ) : error ? (
              <span className="work-search-error" role="alert">{error}</span>
            ) : result ? (
              <span>
                在 {result.files.length} 个文件中找到 {result.totalMatches} 处匹配
                {result.truncated ? '（已达上限，请缩小搜索范围）' : ''}
              </span>
            ) : null}
          </div>
        )}
      </header>

      <div className="work-search-results">
        {result && result.files.length === 0 && !loading && !error && (
          <p className="research-empty">未找到匹配的内容</p>
        )}
        {result?.files.map((file) => {
          const isCollapsed = Boolean(collapsedFiles[file.path]);
          return (
            <div key={file.path} className="work-search-file-group">
              <button
                type="button"
                className={`work-search-file-header${isCollapsed ? '' : ' is-open'}`}
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsedFiles((prev) => ({ ...prev, [file.path]: !prev[file.path] }))}
              >
                <ChevronRight size={14} strokeWidth={1.75} className="work-search-file-chevron" aria-hidden="true" />
                <span className="work-tree-file-icon" aria-hidden="true">
                  <FileTypeIcon file={{ name: file.name, type: '' }} />
                </span>
                <span className="work-search-file-name">{file.name}</span>
                <span className="work-search-file-path" title={file.relativePath}>{file.relativePath}</span>
                <span className="work-search-file-badge">{file.matches.length}</span>
              </button>
              {!isCollapsed && (
                <div className="work-search-file-matches">
                  {file.matches.map((match, idx) => (
                    <button
                      key={`${file.path}:${match.line}:${match.column}:${idx}`}
                      type="button"
                      className="work-search-match-row"
                      onClick={() => revealWorkFileLine(
                        project.id,
                        { kind: 'file', name: file.name, path: file.path, accessible: true },
                        match.line,
                        match.column,
                      )}
                    >
                      <span className="work-search-match-line">{match.line}</span>
                      <code className="work-search-match-text">
                        {renderHighlightedLine(match.text, match.column, match.matchLength)}
                      </code>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
