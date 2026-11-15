# Server agent

This is the home of the agent runtime: the streaming runner, compaction,
diagnostics, the run registry and the `web_search` / `web_fetch` / `file` (list,
read, grep) tools. The pure logic both sides share — context assembly, token
estimates, system and memory prompts, title normalization and provider
validation — lives in `contract/agent-*.ts`. The browser keeps only the SSE
client (`ui/core/api/agent-runs.ts`) and the title/memory side requests
(`ui/core/api/agent-aux.ts`).

## Target layout

```text
server/agent/
├── runtime.ts        # per-conversation run registry, start/stop/steer
├── runner.ts         # pi Agent creation, streaming, retries, cancellation
├── compaction.ts     # silent rolling-summary compaction
├── title.ts          # one-shot title request (normalizer lives in contract/)
├── memory.ts         # background memory summary (shape lives in contract/)
├── diagnostics.ts    # structured, secret-free diagnostics
├── llm/
│   └── direct-stream.ts
├── tool-activity.ts  # binds tool registry activity to the runner hooks
└── tools/            # model-facing tool modules + registry
```

## Boundaries

- **No UI imports.** The agent must not import React, the router, `ui/features`,
  IndexedDB or browser globals.
- **Shared logic comes from `contract/`.** Context assembly, token estimates,
  prompts, title normalization and provider validation are imported from
  `contract/agent-*.ts`. Do not copy them back into `ui/` or re-implement them
  here; the two sides must run the same function, not two equal copies.
- **No HTTP loopback.** Tools call `server/services/*` directly. The browser
  tool adapters' `request('/api/...')` calls do not move here.
- **No model-proxy.** The server calls providers directly from Node. The
  `/api/model-proxy` relay and `scripts/model-proxy.cjs` are removed.
- **Credentials are per-run.** The browser sends the selected model config and
  API key with a run. The server never persists or logs the key. Fastify/pino
  redaction strips `authorization`, `x-api-key` and `apiKey`.
- **The client remains the message writer in this phase.** The run endpoint
  streams updates and a final `end` event; the UI persists the assistant
  message, context summary, title and memory as it does today.
- **Runs are in-memory.** One active run per conversation. A process restart
  drops runs, matching the current browser behavior.

## Run protocol

See `contract/agent-protocol.ts` for the request and event types. The transport is
SSE over `POST /api/agent/runs`:

```text
event: run      { runId, conversationId, replyId }
event: update   { content, reasoning, reasoningActive, activities, process, files, contextTokens }
event: summary  { contextSummary }
event: end      { status, error?, usage? }
```

The UI keeps its deferred-steering and background-notification behavior; only
the source of `ReplyUpdate` events changes.

## Tool responsibilities

- `server/agent/tools/*` owns schemas, prompts, activity mapping and model-facing
  behavior.
- `server/services/*` owns search, fetch, files, documents and PDF work.
- `server/agent/*` owns when tools run, cancellation, retries, budgets and the
  final reply state.

Do not put business logic in the runner or in the route layer; put it in a
service and keep the agent layer about orchestration.
