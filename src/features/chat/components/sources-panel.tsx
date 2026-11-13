import { SourceCard } from './source-card';
import { SidePanel } from './side-panel';
import type { ReplySources } from '../citations';

/**
 * The sources behind one answer. Only sources the text actually cites are listed, and their numbers
 * match the superscript markers; uncited search hits and read pages remain in the normal
 * search/fetch rows instead of being presented as citations.
 */
export function SourcesPanel({ sources, mode, onClose }: {
  sources: ReplySources;
  mode: 'side' | 'sheet';
  onClose: () => void;
}) {
  return <SidePanel title={`来源（${sources.total}）`} mode={mode} onClose={onClose}>
    {sources.citations.map((source) => <SourceCard key={source.label} number={source.number}
      url={source.url} title={source.title} snippet={source.snippet} />)}
  </SidePanel>;
}
