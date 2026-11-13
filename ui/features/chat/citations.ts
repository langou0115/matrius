import type { Message, WebActivity } from '@/core/agent/types';

/** One citation marker in an answer, keyed by its GFM footnote label. */
export type CitationSource = {
  label: string;
  /** The number shown to the reader, assigned by first reference (not by label). */
  number: number;
  title: string;
  url?: string;
  domain?: string;
  snippet?: string;
  /** A definition or a matching search/read result was found, so there is something to show. */
  resolved: boolean;
};

/** The sources an answer actually cites, in marker order. */
export type ReplySources = {
  citations: CitationSource[];
  total: number;
};

export type PreparedCitations = {
  /** Markdown with footnote definitions removed and references rewritten to citation links. */
  markdown: string;
  byLabel: Map<string, CitationSource>;
};

type Line = { text: string; code: boolean; definition: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DEFINITION = /^ {0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/;
const REFERENCE = /\[\^([^\]\n]+)\]/g;
const INLINE_CODE = /(`+)([\s\S]*?)\1/g;
const SOURCE_PREFIX = /^(?:来源|出处|参考|参考资料|source|sources)\s*[:：]\s*/i;

export function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Keep citation links on the same safe surface as the web tools: http(s), without credentials. */
function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Mark fenced code and blank the definition lines in place. The same line array is then used to
 * find references and to produce the rendered Markdown, so a reference is classified once and the
 * two passes cannot disagree about whether it is inside code or inside a definition.
 */
function scanLines(source: string): Line[] {
  const lines: Line[] = [];
  let fence: string | null = null;
  for (const text of source.split('\n')) {
    const marker = FENCE.exec(text);
    if (fence) {
      lines.push({ text, code: true, definition: false });
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker[1];
      lines.push({ text, code: true, definition: false });
    } else {
      lines.push({ text, code: false, definition: false });
    }
  }
  return lines;
}

/** Footnote definitions are the source metadata: the answer body keeps only the markers. */
function collectDefinitions(lines: Line[]): Map<string, string> {
  const definitions = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.code || line.definition) continue;
    const match = DEFINITION.exec(line.text);
    if (!match) continue;
    const label = match[1].trim();
    if (!label) continue;
    let text = match[2].trim();
    line.definition = true;
    let cursor = index + 1;
    // GFM continues a definition on indented lines. Fold them into the metadata instead of
    // leaving them visible as an indented code block after the definition line is removed.
    while (cursor < lines.length && !lines[cursor].code && !lines[cursor].definition
      && /^(?: {2,}|\t)/.test(lines[cursor].text)) {
      const continuation = lines[cursor].text.replace(/^(?: {2,}|\t)+/, '').trimEnd();
      text += (text ? '\n' : '') + continuation;
      lines[cursor].definition = true;
      cursor += 1;
    }
    definitions.set(label, text.trim());
  }
  return definitions;
}

/** Run `transform` over the parts of a line that are not inline code spans. */
function transformProse(line: string, transform: (text: string) => string): string {
  let output = '';
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    output += transform(line.slice(last, index));
    output += match[0];
    last = index + match[0].length;
  }
  return output + transform(line.slice(last));
}

/** GFM numbers footnote references by first appearance, so labels never have to be numeric. */
function collectReferences(lines: Line[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const line of lines) {
    if (line.code || line.definition) continue;
    transformProse(line.text, (text) => {
      for (const match of text.matchAll(REFERENCE)) {
        const label = match[1].trim();
        if (label && !order.has(label)) order.set(label, order.size + 1);
      }
      return text;
    });
  }
  return order;
}

function cleanText(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\\*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s:：\-–—·|,，。；;]+/, '')
    .trim();
}

/** Find one Markdown link and keep balanced parentheses inside its URL, which a plain regex
    truncates on pages such as `https://en.wikipedia.org/wiki/Foo_(bar)`. */
function findMarkdownLink(text: string): { full: string; label: string; url: string } | null {
  const close = text.indexOf('](');
  const open = close >= 0 ? text.lastIndexOf('[', close) : -1;
  if (open < 0 || close < 0) return null;
  let depth = 1;
  let index = close + 2;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') { index += 1; continue; }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return {
    full: text.slice(open, index + 1),
    label: text.slice(open + 1, close),
    url: text.slice(close + 2, index).trim(),
  };
}

/** Trim sentence punctuation and unmatched closing parentheses from a bare URL. */
function balancedUrl(raw: string): string {
  let value = raw.replace(/[.,;，。；]+$/, '');
  while (value.endsWith(')')) {
    const opens = (value.match(/\(/g) ?? []).length;
    const closes = (value.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    value = value.slice(0, -1);
  }
  return value;
}

function parseDefinition(raw: string): { title: string; url?: string; snippet?: string } {
  const text = raw.trim();
  let title = '';
  let url: string | undefined;
  let rest = text;
  const link = findMarkdownLink(text);
  if (link) {
    title = link.label;
    const candidate = link.url
      .replace(/^</, '').replace(/>$/, '')
      .replace(/\s+["'][^"']*["']\s*$/, '');
    if (isSafeHttpUrl(candidate)) url = candidate;
    rest = text.replace(link.full, ' ');
  } else {
    const bare = /<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s>\]]+)/i.exec(text);
    if (bare) {
      const candidate = balancedUrl(bare[1] ?? bare[2]);
      if (isSafeHttpUrl(candidate)) url = candidate;
      rest = text.replace(bare[0], ' ').replace(/[<>]/g, ' ');
    } else {
      title = text;
      rest = '';
    }
  }
  title = cleanText(title).replace(SOURCE_PREFIX, '').trim();
  if (!title) title = cleanText(rest).replace(SOURCE_PREFIX, '').trim();
  const snippet = cleanText(rest.replace(SOURCE_PREFIX, ''));
  return {
    title,
    ...(url ? { url } : {}),
    ...(snippet && snippet !== title ? { snippet } : {}),
  };
}

type ActivitySource = { title?: string; snippet?: string; domain?: string };

/** Search snippets and known page titles make a citation card richer than its definition alone. */
function buildSourceLookup(activities: WebActivity[]): Map<string, ActivitySource> {
  const lookup = new Map<string, ActivitySource>();
  for (const activity of activities) {
    if (activity.kind === 'search') {
      for (const result of activity.results ?? []) {
        const key = normalizedUrl(result.url);
        const existing = lookup.get(key);
        lookup.set(key, {
          title: existing?.title || result.title,
          snippet: existing?.snippet || result.snippet,
          domain: existing?.domain || result.domain || hostname(result.url),
        });
      }
    } else if (activity.kind === 'fetch') {
      const urls = activity.urls ?? (activity.url ? [activity.url] : []);
      for (const value of urls) {
        const key = normalizedUrl(value);
        const existing = lookup.get(key) ?? {};
        const title = activity.url && normalizedUrl(activity.url) === key ? activity.title : undefined;
        lookup.set(key, { ...existing, ...(title && !existing.title ? { title } : {}) });
      }
    }
  }
  return lookup;
}

function analyze(content: string, activities: WebActivity[]) {
  const lines = scanLines(content);
  const definitions = collectDefinitions(lines);
  const order = collectReferences(lines);
  const lookup = buildSourceLookup(activities);
  const citations: CitationSource[] = [];
  const byLabel = new Map<string, CitationSource>();
  for (const [label, number] of order) {
    const raw = definitions.get(label);
    const definition = raw ? parseDefinition(raw) : null;
    const matched = definition?.url ? lookup.get(normalizedUrl(definition.url)) : undefined;
    const url = definition?.url;
    const title = definition?.title || matched?.title || (url ? hostname(url) : `来源 ${number}`);
    const snippet = definition?.snippet || matched?.snippet;
    const source: CitationSource = {
      label,
      number,
      title,
      ...(url ? { url, domain: matched?.domain || hostname(url) } : {}),
      ...(snippet ? { snippet } : {}),
      resolved: !!matched || !!(definition && (definition.title || definition.url || definition.snippet)),
    };
    citations.push(source);
    byLabel.set(label, source);
  }
  return { lines, citations, byLabel };
}

/**
 * Rewrite GFM footnote references into small citation links before Markdown parsing. Definitions
 * are removed from the body: the app renders their metadata as hover cards and in the source panel,
 * so leaving the definition list in the transcript would duplicate every source under every answer.
 *
 * Rewriting even while a definition is still streaming means the reader sees `1` instead of the raw
 * `[^1]` syntax; the number is stable because it is assigned by first reference.
 */
export function prepareCitations(content: string, activities: WebActivity[] = []): PreparedCitations {
  const { lines, citations, byLabel } = analyze(content, activities);
  const numbers = new Map(citations.map((source) => [source.label, source.number]));
  const markdown = lines.map((line) => {
    if (line.definition) return '';
    if (line.code) return line.text;
    return transformProse(line.text, (text) => text.replace(REFERENCE, (match, rawLabel: string) => {
      const label = rawLabel.trim();
      const number = numbers.get(label);
      return number ? `[${number}](#citation-${encodeURIComponent(label)})` : match;
    }));
  }).join('\n');
  return { markdown, byLabel };
}

export function extractCitations(content: string, activities: WebActivity[] = []): CitationSource[] {
  return analyze(content, activities).citations;
}

/**
 * The cited sources of one answer, in marker order. Search hits and pages that were read but never
 * cited stay in the search/fetch rows; the source panel exists to explain the markers in the text,
 * so listing uncited pages there would promise citations the answer does not make.
 */
export function collectReplySources(content: string, activities: WebActivity[] = []): ReplySources {
  const citations = extractCitations(content, activities).filter((source) => source.resolved);
  return { citations, total: citations.length };
}

/** The ordered process is authoritative when present; activities are the synced legacy form. */
export function webActivitiesOf(message: Pick<Message, 'activities' | 'process'>): WebActivity[] {
  const byId = new Map<string, WebActivity>();
  for (const activity of message.activities ?? []) byId.set(activity.id, activity);
  for (const step of message.process ?? []) {
    if (step.kind === 'search' || step.kind === 'fetch') byId.set(step.id, step as WebActivity);
  }
  return [...byId.values()];
}
