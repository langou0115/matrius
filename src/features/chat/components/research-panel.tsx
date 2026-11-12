import { Globe2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import type { WebActivity, WebSearchResult } from '@/core/agent/types';
import {
  hostname, readPages, researchNotes, researchPanelTitle, uniqueSearchResults,
  type FetchedPage, type ResearchGroup,
} from './research-group';

/** The site's own root favicon keeps requests on the result's domain; a 404 or a broken
    response falls back to the neutral globe instead of leaving a broken image. */
function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let source: string | null = null;
  try { source = `https://${new URL(url).hostname}/favicon.ico`; } catch { /* unusable URL */ }
  if (!source || failed) return <Globe2 size={14} aria-hidden="true" />;
  return <img className="research-result-icon" src={source} width={14} height={14} alt=""
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/** One source. The whole card is the link, so a snippet can be selected and read like text. */
function ResultCard({ url, title, snippet, showUrl = false }: {
  url: string;
  title: string;
  snippet?: string;
  showUrl?: boolean;
}) {
  return <a className="research-result" href={url} target="_blank" rel="noopener noreferrer">
    <span className="research-result-site">
      <SiteIcon url={url} />
      <span className="research-result-domain">{hostname(url)}</span>
    </span>
    <span className="research-result-title">{title || hostname(url)}</span>
    {showUrl
      ? <span className="research-result-url">{url}</span>
      : snippet ? <span className="research-result-snippet">{snippet}</span> : null}
  </a>;
}

function isRunning(activities: WebActivity[]): boolean {
  return activities.some((activity) => activity.status === 'running');
}

/**
 * The sources of one aggregated search or read batch. A separate column beside the conversation on
 * a wide viewport and a bottom sheet on a narrow one, so the transcript keeps its rhythm and a long
 * result list scrolls on its own. The header is the place future result actions would attach to.
 */
export function ResearchPanel({ group, mode, onClose }: {
  group: ResearchGroup;
  mode: 'side' | 'sheet';
  onClose: () => void;
}) {
  const title = researchPanelTitle(group.kind);
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const running = isRunning(group.activities);
  const results: WebSearchResult[] = group.kind === 'search' ? uniqueSearchResults(group.activities) : [];
  const pages: FetchedPage[] = group.kind === 'fetch' ? readPages(group.activities) : [];
  // Partial failures stay out of the transcript; the panel that lists the sources also says which
  // ones were skipped, right above them.
  const notes = researchNotes(group.activities);

  useEffect(() => {
    if (mode !== 'side') return;
    // The panel is not modal, so Esc has to keep working even when focus moved back out to the
    // row that opened it.
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  useEffect(() => {
    // The panel is not modal on a wide viewport, so move focus into it (and back out on close)
    // to keep the reading order inside what the reader just opened.
    if (mode === 'side') panel.current?.focus({ preventScroll: true });
  }, [mode]);

  const body = group.kind === 'search'
    ? results.length
      ? results.map((result) => <ResultCard key={result.url} url={result.url} title={result.title} snippet={result.snippet} />)
      : <p className="research-empty">{running ? '正在获取搜索结果…' : '本次检索未找到可用结果。'}</p>
    : pages.length
      ? pages.map((page) => <ResultCard key={page.url} url={page.url} title={page.title ?? ''} showUrl />)
      : <p className="research-empty">{running ? '正在读取页面…' : '没有读取到可用页面。'}</p>;

  const content = <>
    {notes.length > 0 && <div className="research-notes">
      {notes.map((note) => <p key={note.id} className={`research-note${note.error ? ' is-error' : ''}`}>{note.text}</p>)}
    </div>}
    {body}
  </>;

  if (mode === 'sheet') {
    return <Dialog title={title} className="research-sheet" onClose={onClose}>
      <div className="research-panel-body">{content}</div>
    </Dialog>;
  }

  return <aside ref={panel} tabIndex={-1} className="research-panel" aria-labelledby={headingId}>
    <header className="research-panel-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="关闭面板" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="research-panel-body">{content}</div>
  </aside>;
}
