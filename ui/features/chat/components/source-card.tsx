import { Globe2 } from 'lucide-react';
import { useState } from 'react';

import { hostname } from '../citations';

/** The site's own root favicon keeps requests on the result's domain; a 404 or a broken
    response falls back to the neutral globe instead of leaving a broken image. */
export function SiteIcon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  let source: string | null = null;
  if (url) {
    try { source = `https://${new URL(url).hostname}/favicon.ico`; } catch { /* unusable URL */ }
  }
  if (!source || failed) return <Globe2 size={14} aria-hidden="true" />;
  return <img className="research-result-icon" src={source} width={14} height={14} alt=""
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

type Props = {
  url?: string;
  title: string;
  snippet?: string;
  /** Fetched pages have no search snippet; show their URL instead. */
  showUrl?: boolean;
  /** Citation number shown beside the site, matching the marker in the answer. */
  number?: number;
};

/**
 * One source card shared by the search/fetch panel, the "all sources" panel and the citation
 * hover card. The whole card is the link, so a snippet can be selected and read like text; a
 * source without a URL (a footnote that only names a document) stays a plain card.
 */
export function SourceCard({ url, title, snippet, showUrl = false, number }: Props) {
  const site = url ? hostname(url) : '';
  const body = <>
    <span className="research-result-site">
      {number !== undefined ? <span className="research-result-number">{number}</span> : null}
      <SiteIcon url={url} />
      <span className="research-result-domain">{site || '来源'}</span>
    </span>
    <span className="research-result-title">{title || site || '未命名来源'}</span>
    {showUrl && url
      ? <span className="research-result-url">{url}</span>
      : snippet ? <span className="research-result-snippet">{snippet}</span> : null}
  </>;
  return url
    ? <a className="research-result" href={url} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="research-result is-static">{body}</div>;
}
