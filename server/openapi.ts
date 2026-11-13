/**
 * Hand-maintained OpenAPI document for the TypeScript server.
 *
 * Fastify routes validate with zod, not Fastify JSON Schema, so this file is the
 * single place to describe the public contract. Update it when a route is added
 * or its request/response shape changes.
 */

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const int = (description?: string): Schema => ({
  type: 'integer',
  ...(description ? { description } : {}),
});
const bool = (): Schema => ({ type: 'boolean' });
const arr = (items: Schema, maxItems?: number): Schema => ({
  type: 'array',
  items,
  ...(maxItems ? { maxItems } : {}),
});
const obj = (properties: Record<string, Schema>, required?: string[]): Schema => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true });
const jsonBody = (schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const jsonResponse = (description: string, schema?: Schema) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});
const ok = (schema?: Schema) => ({ 200: jsonResponse('OK', schema) });
const created = (schema?: Schema) => ({ 201: jsonResponse('Created', schema) });
const error = (status: string, description: string) => ({
  [status]: jsonResponse(description, ref('Error')),
});

const id = str('UUID');
const timestamp = { type: 'integer', description: 'Epoch milliseconds' };
const errorResponses = {
  ...error('404', 'Not found'),
  ...error('409', 'Revision conflict'),
  ...error('422', 'Validation error'),
  ...error('429', 'Rate limited'),
};

const conversationCreate = obj({
  id: nullable(id),
  clientId: nullable(str('Client-generated id for idempotent creation')),
  title: str(),
  pinned: bool(),
  modelId: nullable(str()),
  titleSource: nullable({ type: 'string', enum: ['auto', 'ai', 'manual'] }),
  contextSummary: nullable(ref('ContextSummary')),
  updatedAt: nullable(timestamp),
});

const conversationPatch = obj({
  baseRevision: int(),
  title: nullable(str()),
  pinned: nullable(bool()),
  modelId: nullable(str()),
  titleSource: nullable({ type: 'string', enum: ['auto', 'ai', 'manual'] }),
  contextSummary: nullable(ref('ContextSummary')),
  readState: nullable(obj({
    completed: nullable(ref('ReadMarker')),
    error: nullable(ref('ReadMarker')),
  })),
}, ['baseRevision']);

const messageCreate = obj({
  id: nullable(id),
  clientId: nullable(str()),
  role: { type: 'string', enum: ['user', 'assistant'] },
  content: str(),
  steering: bool(),
  quote: nullable(str()),
  reasoning: nullable(str()),
  thinkingMs: nullable(int()),
  status: { type: 'string', enum: ['complete', 'stopped', 'error'] },
  error: nullable(str()),
  feedback: nullable({ type: 'string', enum: ['good', 'bad'] }),
  fileIds: arr(id, 20),
  activities: arr(obj({}, []), 50),
  process: nullable(arr(obj({}, []), 100)),
}, ['role']);

const messagePatch = obj({
  baseRevision: int(),
  content: nullable(str()),
  quote: nullable(str()),
  reasoning: nullable(str()),
  thinkingMs: nullable(int()),
  status: nullable({ type: 'string', enum: ['complete', 'stopped', 'error'] }),
  error: nullable(str()),
  feedback: nullable({ type: 'string', enum: ['good', 'bad'] }),
  fileIds: nullable(arr(id, 20)),
  activities: nullable(arr(obj({}, []), 50)),
  process: nullable(arr(obj({}, []), 100)),
}, ['baseRevision']);

const agentModel = obj({
  id: str(),
  name: str(),
  modelId: str(),
  providerId: str(),
  providerName: str(),
  protocol: { type: 'string', enum: ['completion', 'responses', 'message'] },
  baseUrl: { type: 'string', format: 'uri' },
  requiresApiKey: bool(),
  supportsImage: bool(),
  contextWindow: int(),
  maxOutput: int(),
  thinkingEffort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh'] },
}, ['id', 'name', 'modelId', 'providerId', 'providerName', 'protocol', 'baseUrl', 'requiresApiKey', 'supportsImage', 'contextWindow', 'maxOutput']);

const agentMessage = obj({
  id: str(),
  role: { type: 'string', enum: ['user', 'assistant'] },
  content: str(),
  quote: str(),
  feedback: { type: 'string', enum: ['good', 'bad'] },
  steering: { type: 'boolean', enum: [true] },
  images: arr(obj({}, [])),
  fileIds: arr(id),
  files: arr(obj({}, [])),
  reasoning: str(),
  reasoningActive: bool(),
  activities: arr(obj({}, [])),
  process: arr(obj({}, [])),
  thinkingMs: int(),
  status: { type: 'string', enum: ['streaming', 'complete', 'stopped', 'error'] },
  error: str(),
}, ['id', 'role', 'content']);

const agentRun = obj({
  conversationId: str(),
  replyId: str(),
  model: ref('AgentModel'),
  apiKey: str('Temporary per-run credential; never persisted or logged'),
  thinkingEffort: { type: 'string', enum: ['default', 'low', 'medium', 'high'] },
  messages: arr(ref('AgentMessage'), 1000),
  systemPrompt: str(),
  memoryText: str(),
  contextSummary: ref('ContextSummary'),
  tools: obj({ web: bool(), files: bool() }),
}, ['conversationId', 'replyId', 'model', 'messages']);

const schemas: Record<string, Schema> = {
  Error: obj({
    error: obj({
      code: str(),
      message: str(),
      current: obj({}, []),
      details: obj({}, []),
    }, ['code', 'message']),
  }),
  ContextSummary: obj({
    coveredUntilMessageId: str(),
    summary: str(),
  }, ['coveredUntilMessageId', 'summary']),
  ReadMarker: obj({
    state: { type: 'string', enum: ['absent', 'unread', 'read'] },
    readAt: nullable(timestamp),
  }, ['state']),
  Conversation: obj({
    id,
    clientId: nullable(str()),
    title: str(),
    pinned: bool(),
    modelId: nullable(str()),
    titleSource: nullable(str()),
    contextSummary: nullable(ref('ContextSummary')),
    clientUpdatedAt: nullable(timestamp),
    readState: obj({ completed: ref('ReadMarker'), error: ref('ReadMarker') }),
    revision: int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  Message: obj({
    id,
    clientId: nullable(str()),
    conversationId: id,
    position: int(),
    role: str(),
    content: str(),
    steering: bool(),
    quote: nullable(str()),
    feedback: nullable(str()),
    reasoning: nullable(str()),
    activities: nullable(arr(obj({}, []))),
    process: nullable(arr(obj({}, []))),
    thinkingMs: nullable(int()),
    status: str(),
    error: nullable(str()),
    fileIds: arr(id),
    files: arr(ref('File')),
    revision: int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  File: obj({
    id,
    clientId: nullable(str()),
    conversationId: nullable(id),
    filename: str(),
    contentType: str(),
    size: int(),
    sha256: str(),
    status: str(),
    revision: int(),
    createdAt: timestamp,
  }),
  Preference: obj({ themeId: str(), mode: str(), revision: int() }),
  Profile: obj({
    customInstructions: str(),
    aboutName: str(),
    occupation: str(),
    aboutMore: str(),
    revision: int(),
  }),
  ProfileField: obj({
    key: str(),
    value: str(),
    source: str(),
    updatedAt: timestamp,
    revision: int(),
  }),
  Memory: obj({
    id,
    clientId: nullable(str()),
    scope: str(),
    type: str(),
    status: str(),
    content: str(),
    source: str(),
    revision: int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  UsageItem: obj({
    date: str(),
    input: int(),
    output: int(),
    cacheRead: int(),
    cacheWrite: int(),
    requests: int(),
    total: int(),
    estimated: bool(),
  }),
  UsageResponse: obj({
    items: arr(ref('UsageItem')),
    lifetime: obj({ input: int(), output: int(), cacheRead: int(), cacheWrite: int(), requests: int(), total: int() }),
    estimated: obj({ input: int(), output: int(), requests: int(), total: int() }),
    backfilled: bool(),
  }),
  AgentModel: agentModel,
  AgentMessage: agentMessage,
  AgentRunRequest: agentRun,
};

const conversationParameters = [{
  name: 'conversationId',
  in: 'path',
  required: true,
  schema: id,
}];
const messageParameters = [{ name: 'messageId', in: 'path', required: true, schema: id }];
const fileParameters = [{ name: 'fileId', in: 'path', required: true, schema: id }];
const memoryParameters = [{ name: 'memoryId', in: 'path', required: true, schema: id }];

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Matrius API',
    version: '0.1.0',
    description: 'Single-user Matrius instance API. The Node server is a drop-in for the documented /api contract.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'health', description: 'Liveness and readiness' },
    { name: 'features', description: 'Instance capability list' },
    { name: 'conversations', description: 'Conversations and messages' },
    { name: 'workspace', description: 'Preferences, profile, memories and import compatibility' },
    { name: 'files', description: 'Library upload, download and metadata' },
    { name: 'usage', description: 'Token usage reporting and estimates' },
    { name: 'agent', description: 'Streaming agent runs' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['health'],
        summary: 'Process and database liveness',
        responses: { ...ok(obj({ service: str(), status: str() })), ...error('503', 'Unhealthy') },
      },
    },
    '/api/health/ready': {
      get: {
        tags: ['health'],
        summary: 'Database, schema, storage and cache readiness',
        responses: { ...ok(obj({ service: str(), status: str(), checks: obj({}, []), documents: obj({}, []) })), ...error('503', 'Degraded') },
      },
    },
    '/api/features': {
      get: {
        tags: ['features'],
        summary: 'List instance features',
        responses: ok(obj({ features: arr(obj({ id: str(), name: str(), description: str() })) })),
      },
    },
    '/api/conversations': {
      get: {
        tags: ['conversations'],
        summary: 'List conversations with keyset pagination',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: str() },
        ],
        responses: { ...ok(obj({ items: arr(ref('Conversation')), nextCursor: nullable(str()) })), ...errorResponses },
      },
      post: {
        tags: ['conversations'],
        summary: 'Create a conversation (idempotent by id or clientId)',
        requestBody: jsonBody(ref('ConversationCreate')),
        responses: { ...created(ref('Conversation')), ...errorResponses },
      },
    },
    '/api/conversations/{conversationId}': {
      get: {
        tags: ['conversations'],
        summary: 'Conversation detail with a message page',
        parameters: [
          ...conversationParameters,
          { name: 'messageLimit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
          { name: 'before', in: 'query', schema: str() },
        ],
        responses: { ...ok(obj({ conversation: ref('Conversation'), messages: arr(ref('Message')), nextCursor: nullable(str()) })), ...errorResponses },
      },
      patch: {
        tags: ['conversations'],
        summary: 'Update conversation metadata/read state with baseRevision',
        parameters: conversationParameters,
        requestBody: jsonBody(ref('ConversationPatch')),
        responses: { ...ok(ref('Conversation')), ...errorResponses },
      },
      delete: {
        tags: ['conversations'],
        summary: 'Delete a conversation and record deletion tombstones',
        parameters: [...conversationParameters, { name: 'baseRevision', in: 'query', required: true, schema: int() }],
        responses: { ...ok(obj({ ok: bool() })), ...errorResponses },
      },
    },
    '/api/conversations/{conversationId}/messages': {
      post: {
        tags: ['conversations'],
        summary: 'Append a message; position is assigned by the server',
        parameters: conversationParameters,
        requestBody: jsonBody(ref('MessageCreate')),
        responses: { ...created(ref('Message')), ...errorResponses },
      },
    },
    '/api/messages/{messageId}': {
      patch: {
        tags: ['conversations'],
        summary: 'Update a message with baseRevision',
        parameters: messageParameters,
        requestBody: jsonBody(ref('MessagePatch')),
        responses: { ...ok(ref('Message')), ...errorResponses },
      },
      delete: {
        tags: ['conversations'],
        summary: 'Delete a message with baseRevision',
        parameters: [...messageParameters, { name: 'baseRevision', in: 'query', required: true, schema: int() }],
        responses: { ...ok(obj({ ok: bool() })), ...errorResponses },
      },
    },
    '/api/preferences': {
      get: { tags: ['workspace'], summary: 'Get instance preferences', responses: ok(ref('Preference')) },
      put: {
        tags: ['workspace'],
        summary: 'Update preferences with baseRevision',
        requestBody: jsonBody(obj({ baseRevision: int(), themeId: str(), mode: { type: 'string', enum: ['light', 'dark', 'system'] } }, ['baseRevision', 'themeId', 'mode'])),
        responses: { ...ok(ref('Preference')), ...errorResponses },
      },
    },
    '/api/profile': {
      get: { tags: ['workspace'], summary: 'Get profile and custom instructions', responses: ok(ref('Profile')) },
      put: {
        tags: ['workspace'],
        summary: 'Update profile with baseRevision',
        requestBody: jsonBody(obj({ baseRevision: int(), customInstructions: str(), aboutName: str(), occupation: str(), aboutMore: str() }, ['baseRevision'])),
        responses: { ...ok(ref('Profile')), ...errorResponses },
      },
    },
    '/api/profile/fields': {
      get: { tags: ['workspace'], summary: 'List profile fields', responses: ok(obj({ items: arr(ref('ProfileField')) })) },
    },
    '/api/profile/fields/{key}': {
      get: { tags: ['workspace'], summary: 'Read one profile field', parameters: [{ name: 'key', in: 'path', required: true, schema: str() }], responses: { ...ok(ref('ProfileField')), ...errorResponses } },
      put: {
        tags: ['workspace'],
        summary: 'Create or update a profile field',
        parameters: [{ name: 'key', in: 'path', required: true, schema: str() }],
        requestBody: jsonBody(obj({ baseRevision: nullable(int()), value: str(), source: str(), updatedAt: nullable(timestamp) })),
        responses: { ...ok(ref('ProfileField')), ...errorResponses },
      },
      delete: {
        tags: ['workspace'],
        summary: 'Delete a profile field',
        parameters: [
          { name: 'key', in: 'path', required: true, schema: str() },
          { name: 'baseRevision', in: 'query', schema: int() },
        ],
        responses: { ...ok(obj({ ok: bool() })), ...errorResponses },
      },
    },
    '/api/memories': {
      get: {
        tags: ['workspace'],
        summary: 'List memories with keyset pagination',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: str() },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'archived'] } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['global', 'conversation'] } },
        ],
        responses: ok(obj({ items: arr(ref('Memory')), nextCursor: nullable(str()) })),
      },
      post: {
        tags: ['workspace'],
        summary: 'Create a memory (idempotent by id or clientId)',
        requestBody: jsonBody(obj({ id: nullable(id), clientId: nullable(str()), scope: str(), type: str(), status: str(), content: str(), source: str(), createdAt: nullable(timestamp), updatedAt: nullable(timestamp) }, ['type', 'content'])),
        responses: { ...created(ref('Memory')), ...errorResponses },
      },
    },
    '/api/memories/{memoryId}': {
      patch: {
        tags: ['workspace'],
        summary: 'Update a memory with baseRevision',
        parameters: memoryParameters,
        requestBody: jsonBody(obj({ baseRevision: int(), scope: str(), type: str(), status: str(), content: str(), source: str(), updatedAt: nullable(timestamp) }, ['baseRevision'])),
        responses: { ...ok(ref('Memory')), ...errorResponses },
      },
      delete: {
        tags: ['workspace'],
        summary: 'Archive a memory (soft delete)',
        parameters: [...memoryParameters, { name: 'baseRevision', in: 'query', required: true, schema: int() }],
        responses: { ...ok(ref('Memory')), ...errorResponses },
      },
    },
    '/api/workspace/import': {
      post: {
        tags: ['workspace'],
        summary: 'Import browser workspace data into the single instance',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          200: { description: 'Import counters and per-conversation failures' },
          422: { description: 'Unsupported schema version or invalid payload' },
        },
      },
    },
    '/api/workspace/conversation-deletions': {
      get: {
        tags: ['workspace'],
        summary: 'List deletion tombstones for import compatibility',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          { name: 'cursor', in: 'query', schema: str() },
        ],
        responses: ok(obj({ items: arr(str()), nextCursor: nullable(str()) })),
      },
    },
    '/api/files': {
      post: {
        tags: ['files'],
        summary: 'Upload a file (multipart: file, conversationId?, clientId?)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: obj({
                file: { type: 'string', format: 'binary' },
                conversationId: str(),
                clientId: str(),
              }, ['file']),
            },
          },
        },
        responses: { ...created(ref('File')), ...errorResponses },
      },
      get: {
        tags: ['files'],
        summary: 'List files with search, kind, sort and keyset pagination',
        parameters: [
          { name: 'query', in: 'query', schema: str() },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['all', 'image', 'file', 'document', 'text'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created', 'name', 'size'] } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'conversationId', in: 'query', schema: str() },
          { name: 'cursor', in: 'query', schema: str() },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 200 } },
        ],
        responses: ok(obj({ items: arr(ref('File')), nextCursor: nullable(str()) })),
      },
    },
    '/api/files/usage': {
      get: {
        tags: ['files'],
        summary: 'Storage usage split into files and images',
        responses: ok(obj({
          used: int(),
          disk: obj({ total: int(), used: int(), free: int() }),
          files: obj({ bytes: int(), count: int() }),
          images: obj({ bytes: int(), count: int() }),
        })),
      },
    },
    '/api/files/bulk-delete': {
      post: {
        tags: ['files'],
        summary: 'Delete up to 100 owned files',
        requestBody: jsonBody(obj({ ids: arr(id, 100) }, ['ids'])),
        responses: ok(obj({ deleted: int() })),
      },
    },
    '/api/files/{fileId}': {
      get: { tags: ['files'], summary: 'File metadata', parameters: fileParameters, responses: { ...ok(ref('File')), ...errorResponses } },
      patch: {
        tags: ['files'],
        summary: 'Rename a file (extension is fixed)',
        parameters: fileParameters,
        requestBody: jsonBody(obj({ filename: str() }, ['filename'])),
        responses: { ...ok(ref('File')), ...errorResponses },
      },
      delete: { tags: ['files'], summary: 'Delete a file', parameters: fileParameters, responses: { ...ok(obj({ ok: bool() })), ...errorResponses } },
    },
    '/api/files/{fileId}/content': {
      get: {
        tags: ['files'],
        summary: 'Download file bytes',
        parameters: fileParameters,
        responses: {
          200: {
            description: 'File bytes',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          ...errorResponses,
        },
      },
    },
    '/api/usage': {
      get: {
        tags: ['usage'],
        summary: 'Daily usage, lifetime totals and estimate summary',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 366, minimum: 1, maximum: 1095 } }],
        responses: ok(ref('UsageResponse')),
      },
      post: {
        tags: ['usage'],
        summary: 'Report one finished reply run',
        requestBody: jsonBody(obj({
          date: str('YYYY-MM-DD; defaults to UTC today'),
          inputTokens: int(),
          outputTokens: int(),
          cacheReadTokens: int(),
          cacheWriteTokens: int(),
        })),
        responses: ok(obj({ ok: bool() })),
      },
    },
    '/api/usage/backfill': {
      post: {
        tags: ['usage'],
        summary: 'Estimate historical usage once per instance',
        requestBody: jsonBody(obj({ utcOffsetMinutes: int() })),
        responses: ok(obj({
          backfilled: bool(),
          skipped: bool(),
          days: int(),
          requests: int(),
          total: int(),
        })),
      },
    },
    '/api/agent/runs': {
      post: {
        tags: ['agent'],
        summary: 'Start a streaming agent run (SSE)',
        description: 'Returns text/event-stream events: run, update, summary, end. One active run per conversation. The client remains the message writer in this phase.',
        requestBody: jsonBody(ref('AgentRunRequest')),
        responses: {
          200: {
            description: 'Server-Sent Events',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          ...error('409', 'A run is already active for this conversation'),
          ...error('422', 'Validation error'),
        },
      },
    },
    '/api/agent/runs/{conversationId}/steer': {
      post: {
        tags: ['agent'],
        summary: 'Inject a supplement into the active run',
        parameters: conversationParameters,
        requestBody: jsonBody(obj({ message: ref('AgentMessage') }, ['message'])),
        responses: ok(obj({ outcome: { type: 'string', enum: ['steered', 'deferred', false] } })),
      },
    },
    '/api/agent/runs/{conversationId}/stop': {
      post: {
        tags: ['agent'],
        summary: 'Stop the active run',
        parameters: conversationParameters,
        responses: ok(obj({ ok: bool() })),
      },
    },
    '/api/agent/runs/{conversationId}': {
      get: {
        tags: ['agent'],
        summary: 'Whether a run is active',
        parameters: conversationParameters,
        responses: ok(obj({ running: bool() })),
      },
    },
  },
  components: {
    schemas: {
      ...schemas,
      ConversationCreate: conversationCreate,
      ConversationPatch: conversationPatch,
      MessageCreate: messageCreate,
      MessagePatch: messagePatch,
    },
  },
};
