import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { createAgentRunService, type AgentRunService } from './agent/run-service';
import { getSettings, type Settings } from './config';
import { openDatabase, type AppDatabase } from './db/client';
import { migrate } from './db/migrate';
import { AppError, errorBody, validationError, zodDetails } from './errors';
import { registerAgentRoutes } from './routes/agent';
import { registerConversationRoutes } from './routes/conversations';
import { registerDebugRoutes } from './routes/debug';
import { registerFeatureRoutes } from './routes/features';
import { registerFileRoutes } from './routes/files';
import { registerHealthRoutes } from './routes/health';
import { registerUsageRoutes } from './routes/usage';
import { registerWorkspaceRoutes } from './routes/workspace';
import { MemoryCache } from './services/cache';
import { DraftStore } from './services/documents/drafts';
import { createDocumentService, type DocumentToolService } from './services/documents/service';
import { createFetchService } from './services/fetch';
import { createHttpClient } from './services/http';
import { createSearchService } from './services/search';
import { LocalStorage } from './services/storage';

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
  /** Skip migrations only when the caller already prepared the database. */
  migrate?: boolean;
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
  const documents = createDocumentService({ db, storage, settings, cache, drafts });
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
          'apiKey',
          'body.apiKey',
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
  await registerDebugRoutes(app, settings);

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

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: '资源不存在。' } });
  });

  registerHealthRoutes(app, { settings, db, storage, cache });
  registerFeatureRoutes(app);
  registerConversationRoutes(app, { db });
  registerWorkspaceRoutes(app, { db });
  registerUsageRoutes(app, { db });
  registerFileRoutes(app, { db, storage, cache, settings });
  registerAgentRoutes(app, { runs });

  app.addHook('onClose', async () => {
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
  await app.listen({ port: settings.PORT, host: settings.HOST });
  return app;
}
