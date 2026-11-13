# Server agent

This is the new home of the agent runtime. The streaming runner, context
assembly, compaction and the `web_search` / `web_fetch` / `file` (list, read,
grep) tools are implemented here; the browser runtime in `ui/core/agent/`
remains in use until the UI is switched to the SSE client. OfficeCLI editing,
PDF, title and background memory are the next modules to land.

## Target layout

```text
server/agent/
├── runtime.ts        # per-conversation run registry, start/stop/steer
├── runner.ts         # pi Agent creation, streaming, retries, cancellation
├── context.ts        # request history, attachments, steering, token budgets
├── compaction.ts     # silent rolling-summary compaction
├── title.ts          # one-shot title request
├── memory.ts         # background memory summary
├── system-prompt.ts  # stable system prompt only
├── diagnostics.ts    # structured, secret-free diagnostics
├── llm/
│   ├── model-config.ts
│   └── direct-stream.ts
└── tools/            # adapters that bind server/tools modules to a run
```

## Boundaries

- **No UI imports.** The agent must not import React, the router, `ui/features`,
  IndexedDB or browser globals.
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

- `server/tools/*` owns schemas, prompts, activity mapping and model-facing
  behavior.
- `server/services/*` owns search, fetch, files, documents and PDF work.
- `server/agent/*` owns when tools run, cancellation, retries, budgets and the
  final reply state.

Do not put business logic in the runner or in the route layer; put it in a
service and keep the agent layer about orchestration.
