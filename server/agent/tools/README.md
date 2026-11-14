# Agent tools

Every model-facing tool is a **module** with one stable id (the `AgentTool.name`).
The agent runtime only knows the registry; the tool owns its schema, prompt,
activity mapping and service call.

```text
server/agent/tools/
├── types.ts        # ToolModule / ToolContext / activity contract
├── registry.ts     # ordering, feature gating, prompt and activity lookup
├── index.ts        # built-in registration list
├── _template/      # copy this when adding a tool
├── web/            # web_search + web_fetch (implemented)
└── file/           # list/read/grep (implemented); create/edit/save next
```

## Adding a tool

1. Copy `server/agent/tools/_template/` to `server/agent/tools/<name>/`.
2. Set `id` to the exact `AgentTool.name` (`web_search`, `file`, …).
3. Put the JSON Schema in `schema.ts` and use TypeBox, not a hand-written schema.
4. Put business logic in `server/services/<name>.ts` (no pi/agent imports) so it is unit-testable.
5. Put the tool wrapper, prompt fragment and activity adapter in `index.ts`.
6. Register the module in `server/agent/tools/index.ts` after its service exists.
7. Add a test under `server/tests/`.
8. Update `doc/agent.md` if the model-facing contract changes.

## Rules

- **No HTTP loopback.** A server tool calls `server/services/*` directly; it must
  never `fetch('/api/...')` back into this process.
- **No UI imports.** Tools import shared protocol types from `contract/`, never
  `ui/` or React.
- **Feature gating is declarative.** Set `feature` on the module; the registry
  filters it per run and appends `prompt` only when enabled.
- **Activity is optional.** If the tool should appear in the thinking/research
  panel, implement `activity.start`/`activity.end`; otherwise leave it out.
- **Never log secrets.** Tool inputs can contain model API keys or document
  contents. Log tool ids, outcomes and durations only.
- **One module, one id.** Do not reuse the same `AgentTool.name` for two
  modules; the registry rejects duplicates.
