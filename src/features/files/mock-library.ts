import { fileExtension, type LibraryFile } from './files-api';

/**
 * Development-only Library dataset. The preview routes have no account and no server, so
 * `createPreviewFileRequest` implements just enough of `/api/files` to exercise the real
 * screen: 500 entries, search, kind filters, sorting, cursor pagination and mutations.
 */

const TOTAL_FILES = 500;
const PREVIEW_QUOTA = 5 * 1024 * 1024 * 1024;
const PAGE_DELAY_MS = 80;

const IMAGE_NAMES = [
  '截图', '旅行照片', '设计稿', '产品图', '流程图', '海报', '头像', '封面',
] as const;
const DOCUMENT_NAMES = [
  '季度报告', '会议纪要', '需求文档', '项目计划', '报销单', '数据表', '演示文稿',
  '产品说明', '合同', '课程笔记', '调研记录', '发布清单',
] as const;
const TEXT_NAMES = [
  'notes', 'todo', 'README', 'changelog', 'config', 'data', 'script', 'query',
] as const;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  ts: 'text/typescript', tsx: 'text/typescript', py: 'text/x-python', log: 'text/plain',
  yaml: 'text/yaml', html: 'text/html', css: 'text/css', sh: 'text/x-shellscript',
};

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function svgPreview(name: string, hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue} 62% 68%)"/><stop offset="1" stop-color="hsl(${hue + 38} 58% 48%)"/>`
    + `</linearGradient></defs><rect width="120" height="120" fill="url(#g)"/>`
    + `<text x="60" y="68" text-anchor="middle" font-family="sans-serif" font-size="22" fill="white">${name}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createFiles(): LibraryFile[] {
  const random = seededRandom(20261029);
  const now = Date.now();
  const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
  const documentExtensions = ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'] as const;
  const textExtensions = ['md', 'txt', 'csv', 'json', 'ts', 'tsx', 'py', 'log', 'yaml', 'html', 'css', 'sh'] as const;

  return Array.from({ length: TOTAL_FILES }, (_, index) => {
    const image = index % 4 === 0;
    const text = !image && index % 5 === 0;
    const extension = image ? pick(imageExtensions, random)
      : text ? pick(textExtensions, random)
        : pick(documentExtensions, random);
    const base = image ? pick(IMAGE_NAMES, random)
      : text ? pick(TEXT_NAMES, random)
        : pick(DOCUMENT_NAMES, random);
    // Keep every name unique so searching and selecting individual rows stay predictable.
    const suffix = String(index + 1).padStart(3, '0');
    const filename = `${base}-${suffix}.${extension}`;
    const size = image
      ? Math.round(120 * 1024 + random() * 8 * 1024 * 1024)
      : Math.round(2 * 1024 + random() * 3 * 1024 * 1024);
    return {
      id: `preview-file-${suffix}`,
      clientId: `preview-client-${suffix}`,
      conversationId: index % 3 === 0 ? null : `preview-conversation-${1 + (index % 23)}`,
      filename,
      contentType: (image ? IMAGE_TYPES : DOCUMENT_TYPES)[extension] ?? 'application/octet-stream',
      size,
      revision: 1,
      status: 'ready',
      // Newest first by default, spread over roughly the last 60 days.
      createdAt: now - index * 3 * 60 * 60 * 1000 - Math.round(random() * 60 * 60 * 1000),
      ...(image ? { previewUrl: svgPreview(base, Math.round(random() * 360)) } : {}),
    };
  });
}

let files: LibraryFile[] | null = null;
function currentFiles() {
  files ??= createFiles();
  return files;
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function wait(signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, PAGE_DELAY_MS);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function matchesKind(file: LibraryFile, kind: string) {
  const image = file.contentType.startsWith('image/');
  if (kind === 'image') return image;
  if (kind === 'file') return !image;
  if (kind === 'document') return ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(fileExtension(file.filename));
  if (kind === 'text') return !image && !['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(fileExtension(file.filename));
  return true;
}

function sortedFiles(url: URL) {
  const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
  const kind = url.searchParams.get('kind') ?? 'all';
  const sort = url.searchParams.get('sort') ?? 'created';
  const descending = (url.searchParams.get('order') ?? 'desc') === 'desc';
  const rows = currentFiles()
    .filter((file) => matchesKind(file, kind))
    .filter((file) => !query || file.filename.toLowerCase().includes(query));

  const compare = (a: LibraryFile, b: LibraryFile) => {
    const value = sort === 'name' ? a.filename.localeCompare(b.filename, 'zh-CN')
      : sort === 'size' ? a.size - b.size
        : (a.createdAt ?? 0) - (b.createdAt ?? 0);
    return value || a.id.localeCompare(b.id);
  };
  rows.sort(compare);
  return descending ? rows.reverse() : rows;
}

function listPage(url: URL) {
  const rows = sortedFiles(url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, nextCursor: next < rows.length ? String(next) : null };
}

function usage() {
  const rows = currentFiles();
  const images = rows.filter((file) => file.contentType.startsWith('image/'));
  const documents = rows.filter((file) => !file.contentType.startsWith('image/'));
  return {
    used: rows.reduce((total, file) => total + file.size, 0),
    quota: PREVIEW_QUOTA,
    images: { bytes: images.reduce((total, file) => total + file.size, 0), count: images.length },
    files: { bytes: documents.reduce((total, file) => total + file.size, 0), count: documents.length },
  };
}

/** Minimal in-memory `/api/files` for the preview routes. */
export async function previewFileRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, 'http://matrius.preview');
  const method = (init.method ?? 'GET').toUpperCase();
  await wait(init.signal);

  if (method === 'GET' && url.pathname === '/api/files') {
    return listPage(url) as T;
  }
  if (method === 'GET' && url.pathname === '/api/files/usage') {
    return usage() as T;
  }
  if (method === 'POST' && url.pathname === '/api/files/bulk-delete') {
    const { ids } = JSON.parse(String(init.body ?? '{}')) as { ids?: string[] };
    const target = new Set(ids ?? []);
    const rows = currentFiles();
    const deleted = rows.filter((file) => target.has(file.id)).length;
    files = rows.filter((file) => !target.has(file.id));
    return { deleted } as T;
  }

  const id = decodeURIComponent(url.pathname.slice('/api/files/'.length));
  const rows = currentFiles();
  const index = rows.findIndex((file) => file.id === id);

  if (method === 'PATCH' && index >= 0 && url.pathname.startsWith('/api/files/')) {
    const { filename } = JSON.parse(String(init.body ?? '{}')) as { filename?: string };
    const name = (filename ?? '').trim();
    if (!name) throw new Error('文件名不能为空。');
    const updated: LibraryFile = { ...rows[index], filename: name, revision: rows[index].revision ?? 1 };
    files = rows.map((file, row) => row === index ? updated : file);
    return updated as T;
  }
  if (method === 'DELETE' && index >= 0) {
    files = rows.filter((_, row) => row !== index);
    return { ok: true } as T;
  }
  throw new Error('预览数据不支持该操作。');
}
