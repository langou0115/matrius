# Matrius server (TypeScript)

This directory is the single-process Node backend. The Python/FastAPI
implementation has been removed; UI chat now uses the server Agent over SSE.

## Status

| Area | Status |
| --- | --- |
| Fastify app, config, health | implemented |
| SQLite compatibility layer + SQL migrations (`0001`–`0004`) | implemented |
| Storage / in-process cache | implemented |
| Tool registry + `web`, `file`, `ui` tool modules | implemented |
| Conversations + messages routes (CRUD, revisions, keyset pagination) | implemented |
| Scheduled tasks routes & runner (`/api/tasks`) | implemented |
| Preferences / profile / profile fields / memories / deletion tombstones | implemented |
| Files upload/download/list/rename/delete/usage (multipart + local storage) | implemented |
| Usage report / query / one-time backfill | implemented |
| Workspace import + deletion tombstones | implemented |
| Office/PDF text extraction + `file` list/read/grep | implemented |
| OfficeCLI process wrapper, create/edit/help/inspect | implemented |
| Document drafts + create/edit/save/delete in the `file` tool | implemented |
| Legacy Office kit conversion + PDF editing | implemented |
| Search + fetch services and `web_search` / `web_fetch` tools | implemented |
| Agent runtime + SSE run protocol | implemented |
| Agent title / background memory endpoints | implemented |
| UI remote SSE runtime + server title/memory | implemented |
| Server-side model configs & API keys (`/api/models`) | implemented |
| Optional `AUTH_SECRET` splash unlock gate (`/api/auth/*`) | implemented |
| Static `dist/` serving (`APP_ENV=production`) | implemented |

## Debug page

`GET /debug` is a local development dashboard. It currently has two sections:

- **接口查询** — Swagger UI for `/api/openapi.json`, including all implemented routes.
- **运行状态** — live `/api/health/ready` output.

Add future sections in [`server/routes/debug.ts`](routes/debug.ts) via
`DEBUG_SECTIONS`; do not create another top-level debug page. The page is off in
production unless `ENABLE_DEBUG_PAGE=true`. Swagger UI assets come from the
local `swagger-ui-dist` package, so the page works offline.

## Layout

```text
server/
├── main.ts                 # process entry
├── app.ts                  # Fastify assembly, auth gate, static dist/, error handler
├── config.ts               # zod environment + .env.local loading
├── errors.ts               # AppError and the stable error envelope
├── auth/                   # AUTH_SECRET timing-safe check & HMAC HttpOnly cookie
├── db/
│   ├── client.ts           # node:sqlite wrapper + transactions
│   ├── codecs.ts           # UUID / timestamp / JSON / boolean formats
│   ├── migrate.ts          # alembic_version-compatible SQL migrations
│   ├── migrations/         # 0001_initial.sql – 0004_model_configs.sql
│   └── repositories/       # typed data access
├── routes/                 # Fastify route modules (auth, models, tasks, etc.)
├── services/               # storage, cache, search, fetch, documents, PDF
├── agent/                  # agent runtime, title, memory, SSE bridge
│   └── tools/              # model-facing tool modules + registry (web, file, ui)
└── tests/                  # node:test integration/unit tests
```

## Commands

```bash
npm run start             # full vite build + single-process server (API_PORT, default 8000)
npm run dev               # Node API + Vite (data in ~/.matrius by default)
npm run dev:server        # tsx watch server/main.ts, default http://127.0.0.1:8000
npm run db:migrate        # migrate the local development database
npm run typecheck:server  # tsc -p tsconfig.server.json --noEmit
npm run test:server       # node:test via tsx
```

`npm run dev` now launches the Node API, not Python. `npm run dev:server` is
useful when Vite is already running separately.

`npm run dev` uses `scripts/dev-server.mjs` to cache a Vite SSR build in
`node_modules/.cache/matrius-server`. Source metadata, lockfile, Node version,
and builder changes invalidate the cache automatically. Resource paths still
point to the original source directories. The schema dependency graphs are
bundled to reduce small-file I/O on Windows; native and asset-bearing packages
remain external. Documents and the title/memory model runner load on demand.
`npm run dev:server` continues to use tsx watch without this build cache.

## Configuration

Development defaults point at `~/.matrius`. `server/config.ts` reads the repository
`.env.local` in both development and production (process env variables still override it;
`APP_ENV=test` skips `.env.local`).

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_ENV` | `development` | `production` serves `dist/` if built; `test` skips `.env.local` |
| `HOST` / `API_PORT` | `0.0.0.0` / `8000` | Fastify listen address |
| `AUTH_SECRET` | empty | When set, gates `/api/*` & `/debug*` behind splash unlock (`HttpOnly` cookie) |
| `AUTH_SESSION_TTL_SECONDS` | `604800` | Auth cookie lifetime in seconds (7 days) |
| `DATA_DIR` | `~/.matrius` | files, drafts, SQLite |
| `DATABASE_URL` | empty | accepts `sqlite+aiosqlite:///...` for compatibility |
| `SQLITE_BUSY_TIMEOUT_MS` | `30000` | busy timeout |
| `CACHE_MAX_ENTRIES` / `CACHE_MAX_BYTES` | `10000` / 64 MiB | in-process cache |
| `MAX_UPLOAD_BYTES` | 20 MiB | multipart upload limit |
| `STORAGE_LIMIT_BYTES` | 128 MiB | application quota for uploaded files; replaces host-disk reporting |
| `ENABLE_DEBUG_PAGE` | dev only | expose `/debug` and `/api/openapi.json`; production requires `true` |
| `WEBTOOL_PROXY_URL` | empty | optional upstream proxy for search & web fetch |
| `LOG_LEVEL` | `info` | pino level |

## Database compatibility rules

The first TypeScript release is **schema-neutral**. It must open an existing
SQLite file produced by Alembic `0001_initial` without changing any table.

- UUIDs are stored as **32-char lowercase hex**, not dashed UUIDs.
- Timestamps are **`YYYY-MM-DD HH:MM:SS.ffffff` UTC without a suffix**.
- Nullable JSON columns store the literal string **`null`**.
- Booleans are **0/1**.
- `alembic_version` remains the single revision table.

Always use `server/db/codecs.ts`; never pass a `Date` or dashed UUID directly to
SQLite. `server/db/migrate.ts` adopts a database already at `0001_initial` and
refuses to guess at an unversioned database with tables.

## Adding a route

1. Put the route in `server/routes/<area>.ts` as a `register<Area>Routes(app, deps)` function.
2. Validate the body with a zod schema and `schema.parse`.
3. Throw `AppError`/`notFound`/`conflict`/`invalid`; the app error handler owns the JSON shape.
4. Keep SQL in `server/db/repositories/`, not in the route.
5. Add a `server/tests/<area>.test.ts` using `app.inject()`.

## Adding a tool

Read `server/agent/tools/README.md`. The short version: copy `server/agent/tools/_template/`,
keep the service pi-free, set `id` to the `AgentTool.name`, register it in
`server/agent/tools/index.ts` only after the service exists and a test passes.

## Agent

Read `server/agent/README.md`. The agent may import `server/services/*` and
`server/agent/tools/*`, never `ui/*`, React, IndexedDB or `fetch('/api/...')`.
