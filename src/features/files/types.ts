import {
  DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, TEXT_EXTENSIONS, fileExtension,
} from './files-api.web';

export type LibraryKind = 'all' | 'image' | 'file';
export type LibrarySort = 'created' | 'name' | 'size';
export type LibraryOrder = 'asc' | 'desc';

export const KIND_OPTIONS: { id: LibraryKind; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'file', label: '文件' },
];

export const SORT_OPTIONS: { id: LibrarySort; label: string }[] = [
  { id: 'created', label: '上传时间' },
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  try {
    return dateFormat.format(new Date(value));
  } catch {
    return '';
  }
}

/** Mirrors the server's Library filters; `other` files simply never match those filters. */
export function isImageFilename(filename: string): boolean {
  return IMAGE_EXTENSIONS.includes(fileExtension(filename) as never);
}

export function isDocumentFilename(filename: string): boolean {
  return DOCUMENT_EXTENSIONS.includes(fileExtension(filename) as never);
}

export function isTextFilename(filename: string): boolean {
  return TEXT_EXTENSIONS.includes(fileExtension(filename) as never);
}

export function libraryKindOf(filename: string): Exclude<LibraryKind, 'all'> | 'other' {
  if (isImageFilename(filename)) return 'image';
  if (isDocumentFilename(filename) || isTextFilename(filename)) return 'file';
  return 'other';
}

/** Rename keeps the extension: the server rejects a changed suffix. */
export function baseName(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 ? filename.slice(0, index) : filename;
}

export function withExtension(filename: string, extension: string): string {
  return extension ? `${filename}.${extension}` : filename;
}
