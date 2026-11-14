import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { AppError } from '../../errors';

const SNIFF_BYTES = 4_096;
const MAX_TITLE_CHARS = 280;
/** Readability needs enough text to tell an article from a card; below this the DOM walk is better. */
const MIN_READABLE_CHARS = 40;
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);
const TEXTUAL_PREFIXES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/json',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
];
const BINARY_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'font/',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/msword',
  'application/vnd.',
  'application/wasm',
];
const BINARY_MAGIC = [
  Buffer.from('%PDF-'),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from('GIF87a'),
  Buffer.from('GIF89a'),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from('MZ'),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from('Rar!\x1a\x07'),
  Buffer.from('OggS'),
  Buffer.from('ID3'),
  Buffer.from('fLaC'),
];
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;

function unsupported(): AppError {
  return new AppError(422, 'unsupported_content', '该地址不是可提取的文本网页。');
}

export function mimeOf(contentType: string): string {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

export function sniffMime(body: Buffer): string {
  const prefix = body.subarray(0, SNIFF_BYTES);
  if (!prefix.length) return 'text/plain';
  if (prefix.includes(0) || BINARY_MAGIC.some((magic) => prefix.subarray(0, magic.length).equals(magic))) {
    throw unsupported();
  }
  const stripped = prefix.toString('latin1').trimStart().toLowerCase();
  if (/^<(?:!doctype html|html|head|body|main|article)/u.test(stripped)) return 'text/html';
  if (stripped.startsWith('{') || stripped.startsWith('[')) return 'application/json';
  const sample = new TextDecoder('utf-8', { fatal: false }).decode(prefix);
  const printable = [...sample].filter((char) => /[\p{L}\p{N}\p{P}\p{Z}\s]/u.test(char)).length;
  if (!sample || printable / sample.length < 0.85) throw unsupported();
  return 'text/plain';
}

export function resolveMime(contentType: string, body: Buffer): string {
  const mime = mimeOf(contentType);
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return mime;
  if (HTML_MIMES.has(mime) || TEXTUAL_PREFIXES.some((prefix) => mime.startsWith(prefix))) return mime;
  if (BINARY_PREFIXES.some((prefix) => mime.startsWith(prefix))) throw unsupported();
  return sniffMime(body);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Reject anti-bot/JS shells before extracting them as if they were content. */
export function assertReadableHtml(body: string): void {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(body)?.[1] ?? '').toLowerCase();
  const visible = stripTags(body);
  if (/^(?:just a moment|attention required)/u.test(title)) {
    throw new AppError(422, 'fetch_blocked', '该网页返回了验证或访问限制页面，未作为正文读取。');
  }
  if (visible.length < 2000 && ['access denied', 'security check'].includes(title.replace(/[.! ]+$/u, ''))) {
    throw new AppError(422, 'fetch_blocked', '该网页返回了验证或访问限制页面，未作为正文读取。');
  }
  if (body.includes('cf-chl-') && body.length < 20_000) {
    throw new AppError(422, 'fetch_blocked', '该网页返回了验证或访问限制页面，未作为正文读取。');
  }
  if (
    body.toLowerCase().includes('<noscript')
    && visible.length < 500
    && /(?:enable|requires?|need)[^<\n]{0,50}javascript|启用\s*javascript/iu.test(visible)
  ) {
    throw new AppError(422, 'fetch_requires_browser', '该网页需要 JavaScript 渲染，当前读取器无法取得正文，请更换公开来源。');
  }
}

type DomNode = {
  nodeType: number;
  textContent: string | null;
  childNodes?: ArrayLike<DomNode>;
  tagName?: string;
  getAttribute?: (name: string) => string | null;
  parentNode?: DomNode | null;
  remove?: () => void;
};

type DomDocument = DomNode & {
  body?: DomNode | null;
  documentElement?: DomNode | null;
  querySelector: (selector: string) => DomNode | null;
  querySelectorAll: (selector: string) => ArrayLike<DomNode>;
};

function elementChildren(node: DomNode): DomNode[] {
  return Array.from(node.childNodes ?? []).filter((child) => child.nodeType === 1);
}

function tagOf(node: DomNode): string {
  return (node.tagName ?? '').toLowerCase();
}

function isInside(node: DomNode, tags: readonly string[]): boolean {
  let current = node.parentNode;
  while (current) {
    if (tags.includes(tagOf(current))) return true;
    current = current.parentNode;
  }
  return false;
}

/* -------------------------------------------------------------------------------------------- *
 * Page chrome removal and DOM -> Markdown
 * -------------------------------------------------------------------------------------------- */

const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas',
  'input', 'select', 'textarea', 'button', 'nav', 'aside', 'dialog', 'menu',
]);
/** ARIA landmarks that describe navigation and controls rather than the page body. */
const NOISE_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog',
  'menu', 'menubar', 'toolbar',
]);
/** Class/id fragments that mark real content and must win over the noise rules below. */
const CONTENT_MARKER = /(?:^|[\s_-])(?:article|content|entry|post|markdown|documentation|docs?|prose|main|story|body|text|readme)(?:$|[\s_-])/iu;
/** Class/id fragments left by menus, consent banners, ads, comment widgets and similar chrome. */
const NOISE_MARKER = /(?:^|[\s_-])(?:ad|ads|advert|advertisement|banner|cookie|consent|gdpr|menu|nav|navbar|navigation|sidebar|side|footer|header|comment|comments|share|sharing|social|related|recommend|recommendation|subscribe|newsletter|popup|modal|overlay|breadcrumb|pagination|pager|toolbar|login|signin|signup|promo|sponsor|widget|logo|masthead|editsection)(?:$|[\s_-])/iu;

function isHidden(node: DomNode): boolean {
  if (node.getAttribute?.('hidden') !== null && node.getAttribute?.('hidden') !== undefined) return true;
  if ((node.getAttribute?.('aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = (node.getAttribute?.('style') ?? '').toLowerCase();
  return /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(style);
}

/** Class/id noise rules must never delete a structural container that carries the article. */
const STRUCTURAL_TAGS = new Set([
  'main', 'article', 'body', 'html', 'head', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'figure', 'figcaption', 'blockquote',
]);

function pruneChrome(root: DomNode): void {
  for (const node of elementChildren(root)) {
    const tag = tagOf(node);
    if (REMOVE_TAGS.has(tag) || tag === 'footer' || isHidden(node)
      || NOISE_ROLES.has((node.getAttribute?.('role') ?? '').toLowerCase())
      // A header inside article/main is usually the title and byline, so only site headers go.
      || (tag === 'header' && !isInside(node, ['article', 'main']))) {
      node.remove?.();
      continue;
    }
    const marker = `${node.getAttribute?.('class') ?? ''} ${node.getAttribute?.('id') ?? ''}`.trim();
    if (marker && !STRUCTURAL_TAGS.has(tag) && !CONTENT_MARKER.test(marker) && NOISE_MARKER.test(marker)) {
      node.remove?.();
      continue;
    }
    pruneChrome(node);
  }
}

function emptyFence(code: string, minimum: number): string {
  const longest = Math.max(0, ...([...code.matchAll(/`+/gu)].map((match) => match[0].length)));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

/** A list item renders its own block, so nested lists indent under the parent marker. */
function renderListItem(node: DomNode, url: string, depth: number, number: number | null): string {
  const body = inner(node, url, depth + 1).trim();
  const marker = number === null ? '-' : `${number}.`;
  return `${'  '.repeat(depth)}${marker} ${body}`;
}

function renderList(node: DomNode, url: string, depth: number): string {
  const ordered = tagOf(node) === 'ol';
  const items = elementChildren(node).filter((child) => tagOf(child) === 'li');
  if (!items.length) return inner(node, url, depth);
  const start = Number(node.getAttribute?.('start') ?? '1');
  const first = Number.isFinite(start) && start > 0 ? start : 1;
  return `\n${items.map((item, index) => renderListItem(item, url, depth, ordered ? first + index : null)).join('\n')}\n`;
}

function tableRows(node: DomNode): DomNode[] {
  const rows: DomNode[] = [];
  for (const child of elementChildren(node)) {
    const tag = tagOf(child);
    // Nested tables keep their own rows; only direct descendants of this table belong here.
    if (tag === 'table') continue;
    if (tag === 'tr') rows.push(child);
    else rows.push(...tableRows(child));
  }
  return rows;
}

function cellText(node: DomNode, url: string, depth: number): string {
  return inner(node, url, depth).replace(/\s+/gu, ' ').trim().replaceAll('|', '\\|');
}

function renderTable(node: DomNode, url: string, depth: number): string {
  const rows = tableRows(node);
  if (!rows.length) return inner(node, url, depth);
  const cells = rows.map((row) => elementChildren(row)
    .filter((cell) => ['td', 'th'].includes(tagOf(cell)))
    .map((cell) => cellText(cell, url, depth)));
  const width = Math.max(...cells.map((row) => row.length));
  if (!width) return '';
  const lines = cells.map((row) => `| ${row.concat(Array(width - row.length).fill('')).join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

function inner(node: DomNode, url: string, depth = 0): string {
  return Array.from(node.childNodes ?? []).map((child) => render(child, url, depth)).join('');
}

function render(node: DomNode, url: string, depth = 0): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/gu, ' ');
  if (node.nodeType !== 1) return '';
  const tag = tagOf(node);

  if (tag === 'pre') {
    const code = (node.textContent ?? '').replace(/^\n+|\n+$/gu, '');
    const codeNode = Array.from(node.childNodes ?? []).find((child) => tagOf(child) === 'code');
    const language = /(?:^|\s)language-([\w-]+)/iu.exec(
      `${node.getAttribute?.('class') ?? ''} ${codeNode?.getAttribute?.('class') ?? ''}`,
    )?.[1];
    const fence = emptyFence(code, 3);
    return `\n\n${fence}${language ?? ''}\n${code}\n${fence}\n\n`;
  }
  if (tag === 'code') {
    const code = (node.textContent ?? '').replace(/\s+/gu, ' ').trim();
    const fence = emptyFence(code, 1);
    return `${fence}${code}${fence}`;
  }

  if (tag === 'ul' || tag === 'ol') return renderList(node, url, depth);
  if (tag === 'table') return renderTable(node, url, depth);

  const body = inner(node, url, depth);

  if (/^h[1-6]$/u.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
  if (tag === 'a') {
    const label = body.trim();
    const href = node.getAttribute?.('href') ?? '';
    try {
      const parsed = new URL(href, url);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && label) {
        return `[${label}](${parsed.toString().replaceAll(' ', '%20').replaceAll(')', '%29')})`;
      }
    } catch {
      // Malformed link: keep its text.
    }
    return label;
  }
  if (tag === 'strong' || tag === 'b') return body.trim() ? `**${body.trim()}**` : '';
  if (tag === 'em' || tag === 'i') return body.trim() ? `*${body.trim()}*` : '';
  if (tag === 'del' || tag === 's' || tag === 'strike') return body.trim() ? `~~${body.trim()}~~` : '';
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n\n---\n\n';
  if (tag === 'blockquote') {
    const lines = body.trim().split('\n').map((line) => (line ? `> ${line}` : '>'));
    return `\n\n${lines.join('\n')}\n\n`;
  }
  if (tag === 'dt') return body.trim() ? `\n\n**${body.trim()}**\n\n` : '';
  if (['p', 'div', 'section', 'article', 'main', 'figure', 'figcaption', 'dl', 'dd', 'details', 'summary', 'address'].includes(tag)) {
    return body.trim() ? `\n\n${body.trim()}\n\n` : '';
  }
  return body;
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function markdownFromHtml(html: string, url: string): string {
  // Readability returns an element fragment. Linkedom parses a bare uppercase `<DIV>` root
  // outside `document.body`, so wrap the fragment in a complete document before walking it.
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const body = document.body ?? document.documentElement;
  if (!body) return '';
  // Readability can leave shadow-DOM styles and custom-element chrome behind; the serializer
  // is not a privacy boundary, so run the same chrome filter over its output.
  pruneChrome(body as unknown as DomNode);
  return normalizeMarkdown(render(body as unknown as DomNode, url));
}

function truncateTitle(value: string, fallback: string): string {
  const title = value.replace(/\s+/gu, ' ').trim() || fallback;
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
}

function extractTitle(document: DomDocument, url: string): string {
  const title = document.querySelector('title')?.textContent ?? '';
  const heading = document.querySelector('h1')?.textContent ?? '';
  return truncateTitle(stripTags(title) || stripTags(heading), url);
}

function contentRoot(document: DomDocument, mode: 'fast' | 'full'): DomNode | null {
  const fallback = document.body ?? document.documentElement ?? null;
  if (mode === 'full') return fallback;
  // Some news sites ship many small <article> cards; the paragraph-rich node is the page text.
  let best: DomNode | null = null;
  let bestLength = 0;
  for (const node of Array.from(document.querySelectorAll('article, main, [role="main"]'))) {
    const length = (node.textContent ?? '').length;
    if (length > bestLength) { best = node; bestLength = length; }
  }
  return best ?? fallback;
}

/* -------------------------------------------------------------------------------------------- *
 * Extraction
 * -------------------------------------------------------------------------------------------- */

function readableCandidate(html: string, url: string, charThreshold: number): { title: string; text: string } | null {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as never, { charThreshold }).parse();
    if (!article?.content) return null;
    const text = markdownFromHtml(article.content, url);
    if (text.length < MIN_READABLE_CHARS) return null;
    return { title: truncateTitle(article.title ?? '', url), text };
  } catch {
    // Readability is a best-effort extractor; a broken document must not fail the fetch.
    return null;
  }
}

/**
 * Firefox Reader Mode's content extraction. This is the Node equivalent of the trafilatura
 * pass the previous Python server used: it finds the article body from link/text density and
 * drops navigation, consent banners, sidebars, footers and related-link blocks instead of
 * dumping every visible string on the page.
 *
 * `fast` starts with the precision-biased threshold and `full` with recall, then retries the
 * other bias before giving up, mirroring the old extractor's fallback order.
 */
function extractReadable(html: string, url: string, mode: 'fast' | 'full'): { title: string; text: string } | null {
  const thresholds = mode === 'fast' ? [500, 0] : [0, 500];
  for (const charThreshold of thresholds) {
    const candidate = readableCandidate(html, url, charThreshold);
    if (candidate) return candidate;
  }
  return null;
}

export type ExtractedContent = { title: string; text: string; extractor: string };

export function extractContent(
  body: string,
  url: string,
  mode: 'fast' | 'full',
  contentType = 'text/html',
): ExtractedContent {
  const cleaned = body.replace(CONTROL_CHARS, '');
  const mime = mimeOf(contentType);
  if (mime && !HTML_MIMES.has(mime)) {
    return { title: url, text: cleaned.trim(), extractor: 'raw' };
  }
  if (!cleaned.trim()) return { title: url, text: '', extractor: 'none' };
  assertReadableHtml(cleaned);

  const readable = extractReadable(cleaned, url, mode);
  if (readable) return { ...readable, extractor: 'readability' };

  const { document } = parseHTML(cleaned);
  const dom = document as unknown as DomDocument;
  const title = extractTitle(dom, url);
  const page = dom.body ?? dom.documentElement;
  if (page) pruneChrome(page);
  const root = contentRoot(dom, mode);
  let text = root ? normalizeMarkdown(render(root, url)) : '';
  if (!text) text = stripTags(cleaned);
  return { title, text, extractor: text ? 'html_markdown' : 'none' };
}
