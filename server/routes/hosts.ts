import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { detectWorkDocumentFormat } from '../../contract/work-projects';
import type { Settings } from '../config';
import type { AppDatabase } from '../db/client';
import { AppError } from '../errors';
import { convertLegacy, renderOfficeToPdf } from '../services/documents/converter';
import { extensionOf } from '../services/file-types';
import { createHostFsService, type HostFsService } from '../services/host-fs';
import { createWorkHostService, type WorkHostService } from '../services/hosts';
import { renderWorkDocumentPreview } from '../services/work-document-preview';
import { xSpreadsheetToExcelBuffer } from '../services/work-excel-spreadsheet';

const hostKindSchema = z.enum(['ssh', 'wsl']);
const authMethodSchema = z.enum(['agent', 'key', 'password']);

const createHostSchema = z.object({
  kind: hostKindSchema,
  name: z.string().max(120),
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  username: z.string().max(120).optional(),
  authMethod: authMethodSchema.optional(),
  privateKeyPath: z.string().max(500).optional(),
  secret: z.string().max(10_000).optional(),
  distro: z.string().max(120).optional(),
  defaultDirectory: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
});

const patchHostSchema = createHostSchema.extend({
  baseRevision: z.number().int().min(1),
  clearSecret: z.boolean().optional(),
});

const deleteHostQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1).optional(),
});

const fsQuerySchema = z.object({
  path: z.string().max(1000).optional(),
});

const fsBrowseQuerySchema = fsQuerySchema.extend({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
});

const unlockHostSchema = z.object({
  secret: z.string().min(1).max(10_000),
  persist: z.boolean().optional(),
});

export type HostRouteDeps = {
  db: AppDatabase;
  settings?: Settings;
  hosts?: WorkHostService;
  hostFs?: HostFsService;
  runtimeHostSecrets?: Map<string, string>;
};

export function registerHostRoutes(app: FastifyInstance, deps: HostRouteDeps): void {
  const runtimeHostSecrets = deps.runtimeHostSecrets;
  const hosts = deps.hosts ?? createWorkHostService({ db: deps.db, runtimeHostSecrets });
  const hostFs = deps.hostFs ?? createHostFsService({ db: deps.db, runtimeHostSecrets });

  app.get('/api/hosts', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { items: hosts.list() };
  });

  app.get('/api/hosts/wsl/discover', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.discoverWsl();
  });

  app.post('/api/hosts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createHostSchema.parse(request.body ?? {});
    const created = hosts.create(body);
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { hostId: string } }>('/api/hosts/:hostId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = patchHostSchema.parse(request.body ?? {});
    return hosts.update(request.params.hostId, body);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.connect(request.params.hostId);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/disconnect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.disconnect(request.params.hostId);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/unlock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = unlockHostSchema.parse(request.body ?? {});
    return hosts.unlock(request.params.hostId, body.secret, Boolean(body.persist));
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = fsBrowseQuerySchema.parse(request.query ?? {});
    const refresh = query.refresh === '1' || query.refresh === 'true';
    return hostFs.listEntries(request.params.hostId, query.path, { refresh });
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path } = fsQuerySchema.required().parse(request.query ?? {});
    return hostFs.readPreview(request.params.hostId, path);
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs/document', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path } = fsQuerySchema.required().parse(request.query ?? {});
    const format = detectWorkDocumentFormat(path);
    if (format !== 'word' && format !== 'excel' && format !== 'powerpoint') {
      throw new AppError(415, 'document_preview_unsupported', '暂不支持渲染预览此文件类型。');
    }
    const bytes = await hostFs.readBinaryFile(request.params.hostId, path);
    return renderWorkDocumentPreview(path, bytes, deps.settings);
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs/raw', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const { path } = fsQuerySchema.required().parse(request.query ?? {});
    const format = detectWorkDocumentFormat(path);
    if (format !== 'pdf' && format !== 'image' && format !== 'word' && format !== 'excel' && format !== 'powerpoint') {
      throw new AppError(415, 'raw_preview_unsupported', '暂不支持直接内嵌查看此文件类型。');
    }
    const rawBytes = await hostFs.readBinaryFile(request.params.hostId, path);
    const revision = createHash('sha256').update(rawBytes).digest('hex');
    let payload: Buffer = rawBytes;
    let ext = extensionOf(path);
    let converted = false;
    if (ext === 'doc' || ext === 'xls' || ext === 'ppt') {
      if (!deps.settings) {
        throw new AppError(503, 'document_converter_unavailable', '旧版 Office 文件需要 LibreOffice 转换引擎，建议另存为 .docx / .xlsx / .pptx 后查看。');
      }
      const res = await convertLegacy(deps.settings, path, rawBytes);
      payload = res.data;
      ext = res.format;
      converted = true;
    }
    const mimeByExt: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      jfif: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      avif: 'image/avif',
      apng: 'image/apng',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    reply.header('Content-Disposition', 'inline');
    reply.header('X-File-Revision', revision);
    if (converted) reply.header('X-File-Converted', '1');
    reply.type(mimeByExt[ext] ?? 'application/octet-stream');
    return reply.send(payload);
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs/render-pdf', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const { path } = fsQuerySchema.required().parse(request.query ?? {});
    const format = detectWorkDocumentFormat(path);
    if (format !== 'pdf' && format !== 'word' && format !== 'excel' && format !== 'powerpoint') {
      throw new AppError(415, 'raw_preview_unsupported', '暂不支持渲染预览此文件类型。');
    }
    const rawBytes = await hostFs.readBinaryFile(request.params.hostId, path);
    if (format === 'pdf') {
      reply.header('Content-Disposition', 'inline');
      reply.type('application/pdf');
      return reply.send(rawBytes);
    }
    if (!deps.settings) {
      throw new AppError(503, 'document_converter_unavailable', 'LibreOffice 文档渲染引擎不可用。');
    }
    const pdfBytes = await renderOfficeToPdf(deps.settings, path, rawBytes);
    reply.header('Content-Disposition', 'inline');
    reply.type('application/pdf');
    return reply.send(pdfBytes);
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/files/text', { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, text, baseRevision } = z.object({
      path: z.string().min(1).max(1000),
      text: z.string(),
      baseRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    }).parse(request.body ?? {});
    return hostFs.savePreview(request.params.projectId, path, text, baseRevision);
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/files/binary', { bodyLimit: 70 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, dataBase64, baseRevision } = z.object({
      path: z.string().min(1).max(1000),
      dataBase64: z.string().min(1),
      baseRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    }).parse(request.body ?? {});
    const bytes = Buffer.from(dataBase64, 'base64');
    return hostFs.saveBinaryFile(request.params.projectId, path, bytes, baseRevision);
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/files/excel', { bodyLimit: 70 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, spreadsheet, baseRevision } = z.object({
      path: z.string().min(1).max(1000),
      spreadsheet: z.array(z.unknown()).min(1),
      baseRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    }).parse(request.body ?? {});
    const bytes = await xSpreadsheetToExcelBuffer(spreadsheet);
    return hostFs.saveBinaryFile(request.params.projectId, path, bytes, baseRevision);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/files/create', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { parentPath, name, kind } = z.object({
      parentPath: z.string().max(1000).optional(),
      name: z.string().min(1).max(255),
      kind: z.enum(['file', 'directory']),
    }).parse(request.body ?? {});
    const created = await hostFs.createEntry(request.params.projectId, parentPath ?? '', name, kind);
    reply.code(201);
    return created;
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/files/rename', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, newName } = z.object({
      path: z.string().min(1).max(1000),
      newName: z.string().min(1).max(255),
    }).parse(request.body ?? {});
    return hostFs.renameEntry(request.params.projectId, path, newName);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/files/delete', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path } = z.object({
      path: z.string().min(1).max(1000),
    }).parse(request.body ?? {});
    await hostFs.deleteEntry(request.params.projectId, path);
    reply.code(204);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/files/reveal', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path } = z.object({
      path: z.string().max(1000).optional(),
    }).parse(request.body ?? {});
    await hostFs.revealInSystemExplorer(request.params.projectId, path);
    reply.code(204);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/terminal-link', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, cwd, openDirectoryInExplorer } = z.object({
      path: z.string().min(1).max(1000),
      cwd: z.string().max(1000).optional(),
      openDirectoryInExplorer: z.boolean().optional(),
    }).parse(request.body ?? {});
    return hostFs.resolveTerminalLink(request.params.projectId, path, { cwd, openDirectoryInExplorer });
  });

  app.delete<{ Params: { hostId: string } }>('/api/hosts/:hostId', async (request, reply) => {
    const query = deleteHostQuerySchema.parse(request.query ?? {});
    hosts.remove(request.params.hostId, query.baseRevision);
    reply.code(204);
  });
}
