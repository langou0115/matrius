import { createHash, randomUUID } from 'node:crypto';

import type { AppDatabase } from '../../db/client';
import { fromDbUuid, toDbUuid } from '../../db/codecs';
import type { StoredFileRow } from '../../db/repositories/conversations';
import {
  getFileRow,
  insertFileRow,
  replaceFileContent,
  resolveConversationId,
} from '../../db/repositories/files';
import { AppError, conflict, invalid, notFound } from '../../errors';
import type { Settings } from '../../config';
import type { LocalStorage } from '../storage';
import { extensionOf, safeFilename } from '../file-types';
import { validateOfficeCommands, type OfficeCommand } from './commands';
import {
  DRAFT_PREFIX,
  type Draft,
  type DraftStore,
  type DraftSummary,
} from './drafts';
import { convertLegacy } from './converter';
import { officeCreate, officeEdit, officeHelp, officeInspect } from './officecli';
import { applyPdfChanges, inspectPdf, validatePdfChanges } from './pdf';
import {
  createFileToolService,
  grepText,
  sliceText,
  type FileGrepResult,
  type FileListEntry,
  type FileReadResult,
  type FileToolService,
} from './file-service';
import { extractText } from './extract';

export type FileToolRequest = {
  operation: 'list' | 'read' | 'grep' | 'help' | 'inspect' | 'create' | 'edit' | 'save' | 'delete';
  fileId?: string;
  conversationId?: string;
  format?: string;
  filename?: string;
  commands?: OfficeCommand[];
  pdfChanges?: unknown[];
  save?: boolean;
  path?: string;
  element?: string;
  start?: number;
  end?: number;
  maxChars?: number;
  pattern?: string;
  context?: number;
  maxMatches?: number;
};

export type DocumentToolService = {
  run(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>>;
};

const MODERN_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf']);
const LEGACY_FORMATS: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const CONTENT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};
const FILE_ID_HINT = '请传 list 返回的 UUID 或草稿句柄（draft:…），不要传文件名。';
const PDF_HELP = 'PDF 编辑支持：draw_text、replace_page、add_page、remove_page、rotate_page、set_field。';

function detectFormat(filename: string): string | null {
  const extension = extensionOf(filename);
  if (MODERN_FORMATS.has(extension) || extension in LEGACY_FORMATS) return extension;
  return null;
}

function contentTypeFor(format: string): string {
  return CONTENT_TYPES[format] ?? 'application/octet-stream';
}

function fileSummary(row: StoredFileRow): Record<string, unknown> {
  return {
    id: fromDbUuid(row.id),
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    revision: row.revision,
  };
}

function draftResult(draft: Draft, store: DraftStore): Record<string, unknown> {
  const summary: DraftSummary = store.summary(draft);
  return {
    draft: summary,
    fileId: draft.id,
    filename: draft.filename,
    size: draft.size,
    contentType: draft.contentType,
  };
}

function filenameFor(format: string, requested: string | undefined, fallback: string | undefined): string {
  if (requested) {
    const filename = safeFilename(requested);
    if (extensionOf(filename) !== format) throw invalid(`文件名扩展名必须为 .${format}。`);
    return filename;
  }
  if (fallback) {
    const base = safeFilename(fallback);
    const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
    return `${stem}.${format}`;
  }
  return `document.${format}`;
}

type Resolved = {
  ref: string;
  filename: string;
  format: string;
  data: Buffer;
  stored: StoredFileRow | null;
  draft: Draft | null;
  conversationId: string | null;
};

export function createDocumentService(options: {
  db: AppDatabase;
  storage: LocalStorage;
  settings: Settings;
  cache: Parameters<typeof createFileToolService>[0]['cache'];
  drafts: DraftStore;
}): DocumentToolService {
  const { db, storage, settings, cache, drafts } = options;
  const files: FileToolService = createFileToolService({ db, cache, storage });

  async function resolve(instanceId: number, fileId: string | undefined): Promise<Resolved> {
    if (!fileId) throw invalid(`需要 fileId。${FILE_ID_HINT}`);
    if (fileId.startsWith(DRAFT_PREFIX)) {
      const draft = await drafts.get(instanceId, fileId);
      const data = await drafts.read(draft);
      const format = detectFormat(draft.filename);
      if (!format) throw new AppError(415, 'unsupported_file_type', '不支持的文件类型。');
      return {
        ref: fileId,
        filename: draft.filename,
        format,
        data,
        stored: null,
        draft,
        conversationId: draft.conversationId,
      };
    }
    let stored: StoredFileRow | undefined;
    try {
      stored = getFileRow(db, instanceId, fileId);
    } catch {
      throw invalid(`fileId 不合法。${FILE_ID_HINT}`);
    }
    if (!stored) throw notFound('文件不存在。');
    const format = detectFormat(stored.filename);
    if (!format) throw new AppError(415, 'unsupported_file_type', '不支持的文件类型。');
    let data: Buffer;
    try {
      data = storage.get(stored.object_key);
    } catch (error) {
      throw new AppError(502, 'storage_error', '无法读取文件，请稍后重试。', { cause: error });
    }
    return {
      ref: fileId,
      filename: stored.filename,
      format,
      data,
      stored,
      draft: null,
      conversationId: stored.conversation_id ? fromDbUuid(stored.conversation_id) : null,
    };
  }

  async function modernize(resolved: Resolved): Promise<{
    filename: string;
    format: string;
    data: Buffer;
    converted: boolean;
  }> {
    if (LEGACY_FORMATS[resolved.format]) {
      const converted = await convertLegacy(settings, resolved.filename, resolved.data);
      return { ...converted, converted: true };
    }
    if (!MODERN_FORMATS.has(resolved.format)) {
      throw new AppError(415, 'unsupported_file_type', '该文件不能用于文档操作。');
    }
    return {
      filename: resolved.filename,
      format: resolved.format,
      data: resolved.data,
      converted: false,
    };
  }

  async function persist(draft: Draft, requestedFilename?: string): Promise<StoredFileRow> {
    const filename = filenameFor(detectFormat(draft.filename) ?? 'docx', requestedFilename, draft.filename);
    const format = detectFormat(filename);
    if (!format || !MODERN_FORMATS.has(format)) throw invalid('文件格式不支持保存。');
    const data = await drafts.read(draft);
    const digest = createHash('sha256').update(data).digest('hex');
    const contentType = contentTypeFor(format);

    if (draft.baseFileId) {
      const existing = getFileRow(db, draft.instanceId, draft.baseFileId);
      if (!existing) throw notFound('原文件不存在。');
      if (draft.baseRevision !== null && existing.revision !== draft.baseRevision) {
        throw conflict('文件已在其他设备更新，请重新打开后再编辑。', fileSummary(existing));
      }
      const id = fromDbUuid(existing.id);
      const objectKey = `${id}/${filename}`;
      storage.put(objectKey, data);
      const row = replaceFileContent(db, draft.instanceId, existing.id, {
        filename,
        objectKey,
        contentType,
        size: data.length,
        sha256: digest,
      });
      if (existing.object_key !== objectKey) storage.delete(existing.object_key);
      await drafts.delete(draft.instanceId, draft.id);
      return row;
    }

    const id = randomUUID();
    const objectKey = `${id}/${filename}`;
    storage.put(objectKey, data);
    try {
      const row = insertFileRow(db, {
        id,
        instanceId: draft.instanceId,
        clientId: null,
        conversationId: draft.conversationId,
        filename,
        objectKey,
        contentType,
        size: data.length,
        sha256: digest,
      });
      await drafts.delete(draft.instanceId, draft.id);
      return row;
    } catch (error) {
      storage.delete(objectKey);
      throw error;
    }
  }

  async function putDraft(
    instanceId: number,
    data: Uint8Array,
    filename: string,
    conversationId: string | null,
    base?: {
      fileId: string | null;
      revision: number | null;
      draftId?: string | null;
      convertedFromLegacy?: boolean;
    },
  ): Promise<Draft> {
    const format = detectFormat(filename);
    if (!format) throw new AppError(415, 'unsupported_file_type', '不支持的文件类型。');
    return drafts.put({
      instanceId,
      conversationId,
      filename,
      contentType: contentTypeFor(format),
      data,
      baseFileId: base?.fileId ?? null,
      baseRevision: base?.revision ?? null,
      draftId: base?.draftId ?? null,
      convertedFromLegacy: base?.convertedFromLegacy ?? false,
    });
  }

  async function create(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    if (request.fileId) throw invalid('create 不能带 fileId。');
    const format = request.format ?? (request.filename ? detectFormat(request.filename) : null);
    if (!format) throw invalid('create 需要 format 或带格式的文件名。');
    if (!MODERN_FORMATS.has(format)) {
      throw new AppError(503, 'document_converter_unavailable', '当前 Node 服务尚未接入旧版 Office 创建。');
    }
    const filename = filenameFor(format, request.filename, undefined);
    const conversationId = request.conversationId
      ? resolveConversationId(db, instanceId, request.conversationId)
      : undefined;
    if (request.conversationId && !conversationId) throw notFound('对话不存在。');

    let data: Buffer;
    if (format === 'pdf') {
      if (request.commands?.length) throw invalid('PDF 创建请使用 pdfChanges。');
      data = await applyPdfChanges(settings, null, validatePdfChanges(request.pdfChanges));
    } else {
      data = await officeCreate(settings, format);
      if (request.commands?.length) {
        data = await officeEdit(settings, format, data, validateOfficeCommands(request.commands));
      }
    }
    if (request.save) {
      const draft = await putDraft(instanceId, data, filename, conversationId ?? null, { fileId: null, revision: null });
      const row = await persist(draft);
      return { operation: 'create', file: fileSummary(row), savedFileId: fromDbUuid(row.id), fileId: fromDbUuid(row.id), filename: row.filename, size: row.size };
    }
    const draft = await putDraft(instanceId, data, filename, conversationId ?? null, { fileId: null, revision: null });
    return { operation: 'create', ...draftResult(draft, drafts) };
  }

  async function edit(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    const resolved = await resolve(instanceId, request.fileId);
    const modern = await modernize(resolved);
    const isPdf = modern.format === 'pdf' || Boolean(request.pdfChanges);
    let data: Buffer;
    if (isPdf) {
      if (modern.format !== 'pdf') throw invalid('pdfChanges 只能用于 PDF。');
      if (request.commands?.length) throw invalid('PDF 编辑请使用 pdfChanges。');
      data = await applyPdfChanges(settings, modern.data, validatePdfChanges(request.pdfChanges));
    } else {
      if (!request.commands?.length) throw invalid('edit 需要 commands。');
      data = await officeEdit(settings, modern.format, modern.data, validateOfficeCommands(request.commands));
    }
    const filename = filenameFor(modern.format, request.filename, modern.filename);

    if (request.save) {
      const draft = await putDraft(instanceId, data, filename, resolved.conversationId, {
        fileId: modern.converted ? null : resolved.stored ? fromDbUuid(resolved.stored.id) : resolved.draft?.baseFileId ?? null,
        revision: modern.converted ? null : resolved.stored ? resolved.stored.revision : resolved.draft?.baseRevision ?? null,
        convertedFromLegacy: modern.converted,
      });
      const row = await persist(draft);
      return { operation: 'edit', file: fileSummary(row), savedFileId: fromDbUuid(row.id), fileId: fromDbUuid(row.id), filename: row.filename, size: row.size };
    }

    const draft = await putDraft(instanceId, data, filename, resolved.conversationId, {
      fileId: modern.converted ? null : resolved.stored ? fromDbUuid(resolved.stored.id) : resolved.draft?.baseFileId ?? null,
      revision: modern.converted ? null : resolved.stored ? resolved.stored.revision : resolved.draft?.baseRevision ?? null,
      draftId: modern.converted ? null : resolved.draft?.id ?? null,
      convertedFromLegacy: modern.converted,
    });
    return { operation: 'edit', ...draftResult(draft, drafts) };
  }

  async function save(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    if (!request.fileId?.startsWith(DRAFT_PREFIX)) throw invalid('save 只能保存草稿。');
    const draft = await drafts.get(instanceId, request.fileId);
    const row = await persist(draft, request.filename);
    return { operation: 'save', file: fileSummary(row), savedFileId: fromDbUuid(row.id), fileId: fromDbUuid(row.id), filename: row.filename, size: row.size };
  }

  async function list(instanceId: number, conversationId?: string): Promise<FileListEntry[]> {
    const entries = await files.list(instanceId, conversationId);
    const resolvedConversation = conversationId
      ? resolveConversationId(db, instanceId, conversationId)
      : undefined;
    if (conversationId && !resolvedConversation) return [];
    const storedDrafts = await drafts.listForInstance(instanceId, resolvedConversation ?? null);
    const draftEntries: FileListEntry[] = storedDrafts.map((draft) => ({
      id: draft.id,
      filename: draft.filename,
      contentType: draft.contentType,
      size: draft.size,
      draft: true,
      createdAt: draft.createdAt,
    }));
    return [...entries, ...draftEntries]
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, 100);
  }

  async function read(instanceId: number, request: FileToolRequest): Promise<FileReadResult> {
    if (request.fileId?.startsWith(DRAFT_PREFIX)) {
      const draft = await drafts.get(instanceId, request.fileId);
      const text = await extractText(draft.filename, await drafts.read(draft));
      return sliceText(draft.id, draft.filename, text, request.start ?? 1, request.end, request.maxChars ?? 50_000);
    }
    if (!request.fileId) throw invalid('read 需要 fileId。');
    return files.read(instanceId, request.fileId, {
      start: request.start ?? 1,
      ...(request.end !== undefined ? { end: request.end } : {}),
      maxChars: request.maxChars ?? 50_000,
    });
  }

  async function grep(instanceId: number, request: FileToolRequest): Promise<FileGrepResult> {
    if (!request.pattern) throw invalid('grep 需要 pattern。');
    if (request.fileId?.startsWith(DRAFT_PREFIX)) {
      const draft = await drafts.get(instanceId, request.fileId);
      const text = await extractText(draft.filename, await drafts.read(draft));
      return grepText(draft.id, draft.filename, text, request.pattern, request.context ?? 1, request.maxMatches ?? 50);
    }
    if (!request.fileId) throw invalid('grep 需要 fileId。');
    return files.grep(instanceId, request.fileId, {
      pattern: request.pattern,
      context: request.context ?? 1,
      maxMatches: request.maxMatches ?? 50,
    });
  }

  async function remove(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    if (!request.fileId) throw invalid('delete 需要 fileId。');
    if (request.fileId.startsWith(DRAFT_PREFIX)) {
      const draft = await drafts.get(instanceId, request.fileId);
      const filename = draft.filename;
      await drafts.delete(instanceId, request.fileId);
      return { operation: 'delete', fileId: request.fileId, filename, draft: true };
    }
    const stored = getFileRow(db, instanceId, request.fileId);
    if (!stored) throw notFound('文件不存在。');
    storage.delete(stored.object_key);
    db.prepare('DELETE FROM files WHERE id = ? AND instance_id = ?').run(stored.id, instanceId);
    return { operation: 'delete', fileId: fromDbUuid(stored.id), filename: stored.filename };
  }

  async function help(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    let format = request.format;
    if (!format && request.fileId) {
      if (request.fileId.startsWith(DRAFT_PREFIX)) {
        const draft = await drafts.get(instanceId, request.fileId);
        format = detectFormat(draft.filename) ?? undefined;
      } else {
        const stored = getFileRow(db, instanceId, request.fileId);
        format = stored ? detectFormat(stored.filename) ?? undefined : undefined;
      }
    }
    if (!format) throw invalid('help 需要 format 或带格式的文件。');
    if (format === 'pdf') return { operation: 'help', format, text: PDF_HELP, truncated: false };
    if (format in LEGACY_FORMATS) format = LEGACY_FORMATS[format];
    const text = await officeHelp(settings, format, request.element);
    return { operation: 'help', format, text, truncated: text.length >= 30_000 };
  }

  async function inspect(instanceId: number, request: FileToolRequest): Promise<Record<string, unknown>> {
    const resolved = await resolve(instanceId, request.fileId);
    const modern = await modernize(resolved);
    const text = modern.format === 'pdf'
      ? await inspectPdf(modern.data)
      : await officeInspect(settings, modern.format, modern.data, request.path ?? '/');
    return { operation: 'inspect', fileId: resolved.ref, format: modern.format, text, truncated: text.length >= 30_000 };
  }

  return {
    async run(instanceId, request) {
      switch (request.operation) {
        case 'list':
          return { operation: 'list', files: await list(instanceId, request.conversationId) };
        case 'read':
          return read(instanceId, request);
        case 'grep':
          return grep(instanceId, request);
        case 'help':
          return help(instanceId, request);
        case 'inspect':
          return inspect(instanceId, request);
        case 'create':
          return create(instanceId, request);
        case 'edit':
          return edit(instanceId, request);
        case 'save':
          return save(instanceId, request);
        case 'delete':
          return remove(instanceId, request);
        default:
          throw invalid('不支持的操作。');
      }
    },
  };
}
