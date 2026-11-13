import { extname } from 'node:path';

/** Keep these lists in sync with `server/app/files/parsing.py` and `files/router.py`. */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx',
  'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'vue', 'svelte',
]);

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
export const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
export const LEGACY_DOCUMENT_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);
export const ALLOWED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...LEGACY_DOCUMENT_EXTENSIONS,
]);

const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

export function extensionOf(filename: string): string {
  return extname(filename).toLowerCase().replace(/^\./u, '');
}

export function isAllowedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(extensionOf(filename));
}

export function isImage(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filename));
}

export function guessContentType(filename: string): string {
  return CONTENT_TYPES[extensionOf(filename)] ?? 'application/octet-stream';
}

const UNSAFE_NAME = /[^\p{L}\p{N}\p{M}_.\- ]+/gu;

/** Mirror the Python `safe_filename`: basename, bounded, no path separators. */
export function safeFilename(filename: string): string {
  const base = filename.replaceAll('\\', '/').split('/').pop() ?? 'file';
  const safe = base.replace(UNSAFE_NAME, '_').replace(/^[ .]+|[ .]+$/gu, '').slice(0, 120);
  return safe || 'file';
}

/** Escape `%`, `_` and `\` for a `LIKE ... ESCAPE '\'` query. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
