import { Type } from 'typebox';

/** Loose JSON payloads: the service validates them against the component's schemas. */
const jsonValue = Type.Any();

const declaration = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 200 })),
});

const eventDeclaration = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 200 })),
  toAgent: Type.Optional(Type.Boolean()),
});

export const uiComponentParameters = Type.Object({
  action: Type.Union([
    Type.Literal('list'),
    Type.Literal('render'),
    Type.Literal('open'),
    Type.Literal('command'),
    Type.Literal('read_state'),
    Type.Literal('update'),
  ], {
    description: 'list: discover published components; render: show a display-only component with props; open: create a per-conversation binding for a stateful component; command: send a declared command to a binding; read_state: read a binding state; update: write a new component version (UI workshop only).',
  }),
  componentId: Type.Optional(Type.String({ maxLength: 64 })),
  version: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  bindingId: Type.Optional(Type.String({ maxLength: 64 })),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 2_000 })),
  props: Type.Optional(jsonValue),
  html: Type.Optional(Type.String({ maxLength: 200_000 })),
  inputSchema: Type.Optional(jsonValue),
  stateSchema: Type.Optional(jsonValue),
  commands: Type.Optional(Type.Array(declaration, { maxItems: 20 })),
  events: Type.Optional(Type.Array(eventDeclaration, { maxItems: 20 })),
  commandName: Type.Optional(Type.String({ maxLength: 64 })),
  payload: Type.Optional(jsonValue),
});

export const uiComponentToolDescription =
  'The only way to render, inspect or edit UI workshop components. list finds published components; render shows a display-only component with props; open creates a per-conversation binding for a stateful component; command sends one declared command to a binding; read_state reads a binding state; update writes a new component version and is only available inside the UI workshop. Never invent componentId or bindingId values; published components are shared across conversations.';
