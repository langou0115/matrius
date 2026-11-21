import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { createAgentRunService, type AgentRunService } from './agent/run-service';
import { isAuthorizedCookie } from './auth/secret-gate';
import { getSettings, type Settings } from './config';
import { openDatabase, type AppDatabase } from './db/client';
import { migrate } from './db/migrate';
import { AppError, errorBody, validationError, zodDetails } from './errors';
import { registerAgentRoutes } from './routes/agent';
import { registerAuthRoutes } from './routes/auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerDebugRoutes } from './routes/debug';
import { registerFeatureRoutes } from './routes/features';
import { registerFileRoutes } from './routes/files';
import { registerHealthRoutes } from './routes/health';
import { registerHostRoutes } from './routes/hosts';
import { registerModelRoutes } from './routes/models';
import { registerProjectRoutes } from './routes/projects';
import { registerTaskRoutes } from './routes/tasks';
import { registerTerminalRoutes } from './routes/terminals';
import { registerUsageRoutes } from './routes/usage';
import { registerWorkspaceRoutes } from './routes/workspace';
import { MemoryCache } from './services/cache';
import { DraftStore } from './services/documents/drafts';
import type { DocumentToolService } from './services/documents/service';
import { createFetchService } from './services/fetch';
import type { HostFsService } from './services/host-fs';
import type { WorkHostService } from './services/hosts';
import { createHttpClient } from './services/http';
import { createSearchService } from './services/search';
import { LocalStorage } from './services/storage';
import { createWorkTerminalService, type WorkTerminalService } from './services/terminals';

export type AppDependencies = {
  settings: Settings;
  db: AppDatabase;
  storage: LocalStorage;
  cache: MemoryCache;
  documents: DocumentToolService;
  runs: AgentRunService;
};

export type BuildAppOptions = {
  settings?: Settings;
  db?: AppDatabase;
  storage?: LocalStorage;
  cache?: MemoryCache;
  runs?: AgentRunService;
  hosts?: WorkHostService;
  hostFs?: HostFsService;
  terminals?: WorkTerminalService;
  /** Skip migrations only when the caller already prepared the database. */
  migrate?: boolean;
  /** Serve built UI assets from `dist/` (defaults to `settings.APP_ENV === 'production'`). */
  serveStatic?: boolean;
};

export type BuiltApp = {
  app: FastifyInstance;
  deps: AppDependencies;
};

type ValidationItem = { instancePath?: string; message?: string };
type ValidationError = { validation: ValidationItem[] };

function isValidationError(value: unknown): value is ValidationError {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { validation?: unknown }).validation);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const settings = options.settings ?? getSettings();
  const db = options.db ?? openDatabase(settings.databasePath, {
    busyTimeoutMs: settings.SQLITE_BUSY_TIMEOUT_MS,
  });
  if (options.migrate !== false) migrate(db);

  const storage = options.storage ?? new LocalStorage(settings.dataDir);
  storage.ensure();
  const cache = options.cache ?? new MemoryCache({
    maxEntries: settings.CACHE_MAX_ENTRIES,
    maxBytes: settings.CACHE_MAX_BYTES,
  });
  const http = createHttpClient(settings);
  const search = createSearchService({ cache, settings, http });
  const fetch = createFetchService({ cache, settings, http });
  const drafts = new DraftStore(settings);
  await drafts.resetOnStartup();
  // Keep Office/PDF engines off the startup path. Share one service (and one
  // in-flight import) across concurrent tool calls; allow retry after a failure.
  let documentService: Promise<DocumentToolService> | undefined;
  const documents: DocumentToolService = {
    async run(instanceId, request) {
      documentService ??= import('./services/documents/service')
        .then(({ createDocumentService }) => createDocumentService({ db, storage, settings, cache, drafts }))
        .catch((error: unknown) => { documentService = undefined; throw error; });
      return (await documentService).run(instanceId, request);
    },
  };
  const runs = options.runs ?? createAgentRunService({
    services: { search, fetch, files: documents },
  });

  const app = Fastify({
    logger: {
      level: settings.LOG_LEVEL.toLowerCase(),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'apiKey',
          'body.apiKey',
          'body.apiKeys',
          'secret',
          'body.secret',
        ],
        censor: '[redacted]',
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID().replaceAll('-', ''),
    // SSE and uploads can leave keep-alive sockets; a single-user process should
    // shut down promptly instead of waiting for a client timeout.
    forceCloseConnections: true,
  });

  if (settings.corsOrigins.length) {
    await app.register(cors, { origin: settings.corsOrigins, credentials: false });
  }
  await app.register(multipart, {
    limits: { fileSize: settings.MAX_UPLOAD_BYTES, files: 1 },
  });
  await app.register(websocket);
  await registerDebugRoutes(app, { settings, search, fetch });

  if (settings.authEnabled) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const pathname = request.url.split('?', 1)[0] ?? '/';
      const isPublicApi = pathname === '/api/health'
        || pathname === '/api/health/ready'
        || pathname.startsWith('/api/auth/');
      const isProtected = (pathname.startsWith('/api/') && !isPublicApi)
        || pathname === '/debug'
        || pathname.startsWith('/debug-assets/');
      if (!isProtected) return;
      if (!isAuthorizedCookie(request.headers.cookie, settings.AUTH_SECRET)) {
        reply.header('Cache-Control', 'no-store');
        throw new AppError(401, 'auth_required', '请先输入访问密钥解锁。');
      }
    });
  }

  const distRoot = resolve(settings.repoRoot, 'dist');
  const indexHtmlPath = resolve(distRoot, 'index.html');
  const staticEnabled = (options.serveStatic ?? settings.APP_ENV === 'production') && existsSync(indexHtmlPath);
  const indexHtml = staticEnabled ? readFileSync(indexHtmlPath) : null;
  if (staticEnabled) {
    await app.register(fastifyStatic, {
      root: distRoot,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
      index: false,
      setHeaders(reply, filePath) {
        const normalized = filePath.replaceAll('\\', '/');
        if (normalized.endsWith('/sw.js') || normalized.endsWith('/manifest.json') || normalized.endsWith('/index.html')) {
          reply.header('Cache-Control', 'no-cache');
        } else if (normalized.includes('/assets/')) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-ID', request.id);
    if (request.url.startsWith('/api/features')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) reply.headers(error.headers);
      reply.code(error.statusCode).send(errorBody(error));
      return;
    }
    if (error instanceof ZodError) {
      reply.code(422).send(errorBody(validationError(zodDetails(error))));
      return;
    }
    if (isValidationError(error)) {
      const details = error.validation.slice(0, 20).map((item) => ({
        type: 'validation_error',
        loc: item.instancePath ? item.instancePath.split('/').filter(Boolean) : [],
        msg: item.message ?? 'invalid',
      }));
      reply.code(422).send(errorBody(validationError(details)));
      return;
    }
    request.log.error({ err: error }, 'unhandled request error');
    reply.code(500).send({
      error: { code: 'internal_error', message: '服务器内部错误。' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? '/';
    const isAsset = pathname.startsWith('/assets/') || pathname.startsWith('/vendor/') || Boolean(extname(pathname));
    if (
      indexHtml
      && (request.method === 'GET' || request.method === 'HEAD')
      && !pathname.startsWith('/api/')
      && !pathname.startsWith('/debug')
      && !isAsset
    ) {
      reply.header('Cache-Control', 'no-cache');
      reply.type('text/html; charset=utf-8');
      reply.send(request.method === 'HEAD' ? '' : indexHtml);
      return;
    }
    reply.code(404).send({ error: { code: 'not_found', message: '资源不存在。' } });
  });

  registerHealthRoutes(app, { settings, db, storage, cache });
  registerAuthRoutes(app, { settings, cache });
  registerFeatureRoutes(app, settings);
  registerConversationRoutes(app, { db });
  registerWorkspaceRoutes(app, { db });
  registerModelRoutes(app, { db });
  const runtimeHostSecrets = new Map<string, string>();
  registerHostRoutes(app, {
    db,
    runtimeHostSecrets,
    ...(options.hosts ? { hosts: options.hosts } : {}),
    ...(options.hostFs ? { hostFs: options.hostFs } : {}),
  });
  const terminals = options.terminals ?? createWorkTerminalService({ db, runtimeHostSecrets });
  registerProjectRoutes(app, { db, terminals });
  registerTerminalRoutes(app, { db, terminals });
  registerUsageRoutes(app, { db });
  registerTaskRoutes(app, { db });
  registerFileRoutes(app, { db, storage, cache, settings });
  registerAgentRoutes(app, { runs, db });

  app.addHook('onClose', async () => {
    terminals.disposeAll();
    runs.dispose();
  });
  if (!options.db) {
    app.addHook('onClose', async () => {
      db.close();
    });
  }

  return { app, deps: { settings, db, storage, cache, documents, runs } };
}

export async function start(): Promise<FastifyInstance> {
  const settings = getSettings();
  const { app } = await buildApp({ settings });
  await app.listen({ port: settings.API_PORT, host: settings.HOST });
  return app;
}
