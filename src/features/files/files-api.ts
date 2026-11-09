import type { MessageFile } from '@/core/agent/types';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type LibraryFile = MessageFile & {
  clientId?: string | null;
  conversationId?: string | null;
  sha256?: string;
  status?: string;
  createdAt?: number;
  /** Preview-only thumbnail; the real API serves images from `/api/files/{id}/content`. */
  previewUrl?: string;
};

export type FileListParams = {
  query?: string;
  kind?: 'all' | 'image' | 'file' | 'document' | 'text';
  sort?: 'created' | 'name' | 'size';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
};

export type FileListPage = { items: LibraryFile[]; nextCursor: string | null };
export type StorageCategory = { bytes: number; count: number };
/** `files` is every non-image entry, so `files` and `images` add up to `used`. */
export type StorageUsage = {
  used: number;
  disk: { total: number; used: number; free: number };
  files?: StorageCategory;
  images?: StorageCategory;
};

/** Kept in sync with server/app/files/router.py. */
export const MAX_UPLOADS = 10;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_CONCURRENCY = 3;
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'] as const;
export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx',
  'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'vue', 'svelte',
] as const;

const ALLOWED_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...TEXT_EXTENSIONS,
]);

export function fileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}

// Only formats the server stores as images and the model accepts inline.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isImageAttachment(file: Pick<File, 'type' | 'name'>): boolean {
  return IMAGE_TYPES.has(file.type) || IMAGE_EXTENSIONS.includes(fileExtension(file.name) as never);
}

export function isDocumentFile(filename: string): boolean {
  return DOCUMENT_EXTENSIONS.includes(fileExtension(filename) as never);
}

export function isAllowedAttachment(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(fileExtension(filename));
}

export function toMessageFile(file: LibraryFile): MessageFile {
  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    ...(typeof file.revision === 'number' ? { revision: file.revision } : {}),
  };
}

/** Multipart upload; never set Content-Type so the browser adds the boundary. */
export async function uploadFile(
  request: ApiRequest,
  file: File,
  { clientId, conversationId, signal }: { clientId: string; conversationId?: string; signal?: AbortSignal },
): Promise<LibraryFile> {
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('clientId', clientId);
  if (conversationId) body.append('conversationId', conversationId);
  return request<LibraryFile>('/api/files', { method: 'POST', body, signal });
}

export async function listFiles(request: ApiRequest, params: FileListParams = {}, signal?: AbortSignal): Promise<FileListPage> {
  const search = new URLSearchParams();
  if (params.query?.trim()) search.set('query', params.query.trim());
  if (params.kind && params.kind !== 'all') search.set('kind', params.kind);
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  if (params.cursor) search.set('cursor', params.cursor);
  search.set('limit', String(params.limit ?? 50));
  return request<FileListPage>(`/api/files?${search.toString()}`, { signal });
}

export async function getFileUsage(request: ApiRequest, signal?: AbortSignal): Promise<StorageUsage> {
  return request<StorageUsage>('/api/files/usage', { signal });
}

export async function renameFile(request: ApiRequest, id: string, filename: string): Promise<LibraryFile> {
  return request<LibraryFile>(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ filename }),
  });
}

export async function bulkDeleteFiles(request: ApiRequest, ids: string[]): Promise<{ deleted: number }> {
  return request<{ deleted: number }>('/api/files/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function deleteFile(request: ApiRequest, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fileContentUrl(id: string): string {
  return `/api/files/${encodeURIComponent(id)}/content`;
}
