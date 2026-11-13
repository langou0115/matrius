import { parseHTML } from 'linkedom';

import { AppError } from '../../errors';

const SNIFF_BYTES = 4_096;
const MAX_TITLE_CHARS = 280;
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

function elementChildren(node: DomNode): DomNode[] {
  return Array.from(node.childNodes ?? []).filter((child) => child.nodeType === 1);
}

function collect(node: DomNode, tag: string): DomNode[] {
  const found: DomNode[] = [];
  for (const child of elementChildren(node)) {
    if ((child.tagName ?? '').toLowerCase() === tag) found.push(child);
    found.push(...collect(child, tag));
  }
  return found;
}

function inner(node: DomNode, url: string): string {
  return Array.from(node.childNodes ?? []).map((child) => render(child, url)).join('');
}

function fenceFor(code: string, minimum: number): string {
  const longest = Math.max(0, ...([...code.matchAll(/`+/gu)].map((match) => match[0].length)));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

function renderTable(node: DomNode, url: string): string {
  const rows = collect(node, 'tr');
  if (!rows.length) return inner(node, url);
  const cells = rows.map((row) => elementChildren(row)
    .filter((cell) => ['td', 'th'].includes((cell.tagName ?? '').toLowerCase()))
    .map((cell) => stripTags(cell.textContent ?? '').replaceAll('|', '\\|')));
  const width = Math.max(...cells.map((row) => row.length));
  if (!width) return '';
  const lines = cells.map((row) => `| ${row.concat(Array(width - row.length).fill('')).join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

function render(node: DomNode, url: string): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const tag = (node.tagName ?? '').toLowerCase();
  const body = inner(node, url);

  if (tag === 'pre') {
    const code = (node.textContent ?? '').replace(/^\n+|\n+$/gu, '');
    const fence = fenceFor(code, 3);
    return `\n\n${fence}\n${code}\n${fence}\n\n`;
  }
  if (tag === 'table') return renderTable(node, url);
  if (/^h[1-6]$/u.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
  if (tag === 'li') {
    const prefix = (node.parentNode?.tagName ?? '').toLowerCase() === 'ol' ? '1.' : '-';
    return `\n${prefix} ${body.trim()}\n`;
  }
  if (tag === 'a') {
    const href = node.getAttribute?.('href') ?? '';
    try {
      const parsed = new URL(href, url);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && body.trim()) {
        return `[${body.trim()}](${parsed.toString().replaceAll(' ', '%20').replaceAll(')', '%29')})`;
      }
    } catch {
      // Malformed link: keep its text.
    }
    return body;
  }
  if (tag === 'code') {
    const code = (node.textContent ?? '').trim();
    return `${fenceFor(code, 1)}${code}${fenceFor(code, 1)}`;
  }
  if (tag === 'br') return '\n';
  if (tag === 'blockquote') return `\n\n> ${body.trim()}\n\n`;
  if (['p', 'div', 'section', 'article', 'main', 'ul', 'ol'].includes(tag)) {
    return `\n\n${body.trim()}\n\n`;
  }
  return body;
}

function truncateTitle(value: string, fallback: string): string {
  const title = value.replace(/\s+/gu, ' ').trim() || fallback;
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
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
  assertReadableHtml(cleaned);

  const { document } = parseHTML(cleaned);
  for (const selector of ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed']) {
    const nodes = Array.from(document.querySelectorAll(selector)) as DomNode[];
    nodes.forEach((node) => node.remove?.());
  }

  const titleNode = document.querySelector('title') ?? document.querySelector('h1');
  const title = truncateTitle(titleNode?.textContent ?? '', url);
  const main = mode === 'fast'
    ? document.querySelector('article, main, [role="main"]')
    : null;
  const root = (main ?? document.body ?? document.querySelector('body')) as unknown as DomNode | null;
  let text = root ? render(root, url).replace(/\n[ \t]*\n(?:[ \t]*\n)+/gu, '\n\n').trim() : '';
  if (!text) {
    text = stripTags(cleaned);
  }
  return { title, text, extractor: 'html_markdown' };
}
