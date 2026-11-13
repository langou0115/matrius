# Tool module template

Copy this directory to `server/tools/<name>/`, then replace the placeholders.
The example compiles and is intentionally **not** registered in
`server/tools/index.ts`.

```ts
// schema.ts
import { Type } from 'typebox';

export const parameters = Type.Object({
  text: Type.String({ description: 'Text to echo back.', maxLength: 10_000 }),
});
```

```ts
// index.ts
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from 'typebox';
import type { ToolModule } from '../types';

const parameters = Type.Object({
  text: Type.String({ description: 'Text to echo back.', maxLength: 10_000 }),
});
type Params = Static<typeof parameters>;
type Details = { length: number };

const tool: AgentTool<typeof parameters, Details> = {
  name: 'echo',
  label: 'Echo',
  description: 'Echo the supplied text. Replace this with a real service call.',
  parameters,
  executionMode: 'sequential',
  execute: async (_toolCallId, params: Params) => ({
    content: [{ type: 'text', text: params.text }],
    details: { length: params.text.length },
  }),
};

export const echoTool: ToolModule = {
  id: 'echo',
  create: () => tool,
};
```

The real module should also export:

- `service.ts` — pure/business logic, no `@mariozechner/*` imports;
- `activity.ts` — optional `start`/`end` mapping to `WebActivity`;
- a system prompt fragment only if the model needs guidance.
