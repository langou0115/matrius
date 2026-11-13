import type { WebActivity, WebSearchResult } from '@/core/agent/types';
import { readPages, researchNotes, researchPanelTitle, uniqueSearchResults,
  type FetchedPage, type ResearchGroup } from './research-group';
import { SourceCard } from './source-card';
import { SidePanel } from './side-panel';

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
  const running = isRunning(group.activities);
  const results: WebSearchResult[] = group.kind === 'search' ? uniqueSearchResults(group.activities) : [];
  const pages: FetchedPage[] = group.kind === 'fetch' ? readPages(group.activities) : [];
  // Partial failures stay out of the transcript; the panel that lists the sources also says which
  // ones were skipped, right above them.
  const notes = researchNotes(group.activities);

  const body = group.kind === 'search'
    ? results.length
      ? results.map((result) => <SourceCard key={result.url} url={result.url} title={result.title} snippet={result.snippet} />)
      : <p className="research-empty">{running ? '正在获取搜索结果…' : '本次检索未找到可用结果。'}</p>
    : pages.length
      ? pages.map((page) => <SourceCard key={page.url} url={page.url} title={page.title ?? ''} showUrl />)
      : <p className="research-empty">{running ? '正在读取页面…' : '没有读取到可用页面。'}</p>;

  return <SidePanel title={title} mode={mode} onClose={onClose}>
    {notes.length > 0 && <div className="research-notes">
      {notes.map((note) => <p key={note.id} className={`research-note${note.error ? ' is-error' : ''}`}>{note.text}</p>)}
    </div>}
    {body}
  </SidePanel>;
}
