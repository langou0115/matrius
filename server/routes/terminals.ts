import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { MAX_WORK_EDITOR_FONT_SIZE, MIN_WORK_EDITOR_FONT_SIZE, WORK_EDITOR_DIFF_LAYOUTS } from '../../contract/work-projects';
import type { WorkTerminalClientMessage } from '../../contract/work-terminals';
import type { AppDatabase } from '../db/client';
import { getWorkSettingsRow, updateWorkSettingsRow } from '../db/repositories/terminals';
import type { WorkTerminalService } from '../services/terminals';

const INSTANCE_ID = 1;

const listQuerySchema = z.object({
  projectId: z.string().max(120).optional(),
});

const createTerminalSchema = z.object({
  projectId: z.string().min(1).max(120),
  preset: z.enum(['shell', 'claude', 'codex', 'antigravity']).optional(),
  shell: z.enum(['powershell', 'cmd']).optional(),
  cliSessionId: z.string().max(200).optional(),
  title: z.string().max(80).optional(),
  command: z.string().max(500).optional(),
  cols: z.number().int().min(20).max(400).optional(),
  rows: z.number().int().min(6).max(200).optional(),
});

const patchTerminalSchema = z.object({
  title: z.string().max(80).optional(),
  pinned: z.boolean().optional(),
  cliSessionId: z.string().min(1).max(200).optional(),
});

const resumeTerminalSchema = z.object({
  cols: z.number().int().min(20).max(400).optional(),
  rows: z.number().int().min(6).max(200).optional(),
  password: z.string().max(10_000).optional(),
  rememberPassword: z.boolean().optional(),
});

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(6).max(200),
  }),
  z.object({
    type: z.literal('ack'),
    chars: z.number().int().min(1).max(2_000_000),
  }),
]);

const workSettingsUpdateSchema = z.object({
  defaultWindowsShell: z.enum(['powershell', 'cmd']).optional(),
  activeProjectId: z.string().max(120).nullable().optional(),
  activeTerminals: z.record(z.string().max(120), z.string().max(120).nullable()).optional(),
  filesPanelOpen: z.boolean().optional(),
  filesPanelWidth: z.number().int().min(220).max(640).nullable().optional(),
  persistTerminalScrollback: z.boolean().optional(),
  editorFontSize: z.number().int().min(MIN_WORK_EDITOR_FONT_SIZE).max(MAX_WORK_EDITOR_FONT_SIZE).optional(),
  editorAutoSave: z.boolean().optional(),
  editorDiffLayout: z.enum(WORK_EDITOR_DIFF_LAYOUTS).optional(),
  projectOrder: z.array(z.string().min(1).max(120)).max(500).optional(),
  cliProviderOrder: z.array(z.enum(['codex', 'antigravity', 'claude'])).max(10).optional(),
  terminalOrder: z.array(z.string().min(1).max(120)).max(500).optional(),
});

export type TerminalRouteDeps = {
  db?: AppDatabase;
  terminals: WorkTerminalService;
};

export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  const { db, terminals } = deps;

  if (db) {
    app.get('/api/work/settings', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return getWorkSettingsRow(db, INSTANCE_ID);
    });

    app.put('/api/work/settings', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const body = workSettingsUpdateSchema.parse(request.body ?? {});
      const updated = db.transaction(() => updateWorkSettingsRow(db, INSTANCE_ID, body));
      if (body.persistTerminalScrollback !== undefined) {
        terminals.setPersistScrollback?.(updated.persistTerminalScrollback);
      }
      return updated;
    });
  }

  app.get('/api/work/terminals', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = listQuerySchema.parse(request.query ?? {});
    return {
      items: terminals.list(query.projectId),
      platform: terminals.platform,
      ...(terminals.windowsBuild !== undefined ? { windowsBuild: terminals.windowsBuild } : {}),
    };
  });

  app.post('/api/work/terminals', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createTerminalSchema.parse(request.body ?? {});
    const created = await terminals.create(body);
    reply.code(201);
    return created;
  });

  app.post<{ Params: { terminalId: string } }>('/api/work/terminals/:terminalId/resume', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = resumeTerminalSchema.parse(request.body ?? {});
    return terminals.resume(request.params.terminalId, body);
  });

  app.patch<{ Params: { terminalId: string } }>('/api/work/terminals/:terminalId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = patchTerminalSchema.parse(request.body ?? {});
    return terminals.update(request.params.terminalId, body);
  });

  app.delete<{ Params: { terminalId: string } }>('/api/work/terminals/:terminalId', async (request, reply) => {
    terminals.remove(request.params.terminalId);
    reply.code(204);
  });

  app.get<{ Params: { terminalId: string } }>(
    '/api/work/terminals/:terminalId/ws',
    { websocket: true },
    (socket, request) => {
      const terminalId = request.params.terminalId;
      let attached;
      try {
        attached = terminals.attach(terminalId, (message) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(message));
          }
        });
      } catch {
        socket.close(4404, 'Terminal not found');
        return;
      }

      if (attached.snapshot) {
        socket.send(JSON.stringify({ type: 'snapshot', data: attached.snapshot }));
      }
      socket.send(JSON.stringify({
        type: 'status',
        status: attached.session.status,
        exitCode: attached.session.exitCode,
        ...(attached.session.errorMessage ? { message: attached.session.errorMessage } : {}),
      }));

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const text = Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : Buffer.from(raw).toString('utf8');
          const parsed = clientMessageSchema.parse(JSON.parse(text)) as WorkTerminalClientMessage;
          if (parsed.type === 'input') {
            terminals.write(terminalId, parsed.data);
          } else if (parsed.type === 'resize') {
            terminals.resize(terminalId, parsed.cols, parsed.rows);
          } else if (parsed.type === 'ack') {
            terminals.ack?.(terminalId, parsed.chars);
          }
        } catch {
          // Ignore malformed control frames without dropping the terminal socket.
        }
      });

      socket.on('close', () => {
        attached.detach();
      });
    },
  );
}
