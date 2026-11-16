/**
 * Model-facing instructions for the UI workshop.
 *
 * The contract is repeated here rather than inferred from examples: a generated
 * component is real code running in a sandbox, so the host-provided root, the
 * bridge API and the no-network rules must be unambiguous.
 */

const COMPONENT_CONTRACT = `## UI component contract (must follow exactly)

- Submit an **HTML fragment only**: no doctype, no <html>/<head>/<body>. The host renders
  <div id="root"></div> and appends your fragment, so style and script tags are fine.
- Every component defines \`function render(root, ctx)\` and draws the whole UI into \`root\`.
  \`ctx.props\` is the data validated against \`inputSchema\`; \`ctx.state\` is the persisted
  state for stateful components; \`ctx.theme\` carries theme colors.
- No network, CDN, external fonts or images, no localStorage, cookies, eval or new Function.
  The sandbox blocks all of them; inline everything and use data: URLs if needed.
- Style with the theme variables \`var(--matrius-background)\`, \`--matrius-foreground\`,
  \`--matrius-card\`, \`--matrius-muted\`, \`--matrius-muted-foreground\`, \`--matrius-border\`,
  \`--matrius-primary\`. Keep it responsive; never set a fixed page height. The host resizes
  the iframe to the root's height.
- Display-only components take data through \`props\` and need no state.
- Stateful components declare \`stateSchema\` (JSON Schema) and \`commands\` (names the model may
  send), implement \`function onCommand(name, payload, ctx)\` and return
  \`{ ok: true, state: nextState }\` or \`{ ok: false, error: 'reason' }\`. \`state\` must be the
  complete new state; the host persists it per conversation. Call \`MatriusUI.setState(next)\`
  for local interactions so the host also persists them.
- Interactive components may declare \`events\` and call \`MatriusUI.emit(name, payload)\`.
  Set \`toAgent: true\` only when the assistant should be offered the event as a follow-up.
- \`MatriusUI\` also exposes \`resize()\` and \`commandResult()\`; the bridge already handles them.

Minimal stateful skeleton:

<style>
  .board { display: grid; gap: 4px; }
</style>
<script>
  function render(root, ctx) {
    root.textContent = '';
    var board = document.createElement('div');
    board.className = 'board';
    board.textContent = ctx.state ? ctx.state.label : '加载中';
    root.appendChild(board);
  }
  function onCommand(name, payload, ctx) {
    if (name === 'reset') return { ok: true, state: { label: '新的一局' } };
    return { ok: false, error: '未知命令：' + name };
  }
</script>`;

const TOOL_GUIDE = `## UI workshop tool

Call \`ui_component\` instead of describing UI code in prose.

- \`list\`: returns the user's published components. Call it before offering a visualization;
  never invent a componentId. If the list is empty or nothing matches, answer normally.
- \`render\`: display-only component with \`props\` validated against its schema. Put the data
  in \`props\`, not in the reply text.
- \`open\`: stateful component. Creates a per-conversation binding and returns its bindingId.
  The component creates its own initial state and reports it back.
- \`command\`: \`{ bindingId, commandName, payload }\`. Only commands declared by that version
  are accepted. Send one command per user request; the component validates it and reports the
  new state. Use \`read_state\` first when the move depends on the current state.
- \`update\`: only inside the UI workshop. Write the **complete** \`html\` plus \`inputSchema\`
  and, for stateful components, \`stateSchema\`, \`commands\` and \`events\` (declarations are not
  inherited automatically). Keep the same component and describe the change in one short
  sentence; never paste the code back.

When you render something, write one short sentence about what is on screen. Do not repeat
the data, the schema or the component code as text.`;

export function uiComponentRuntimePrompt(options: {
  scope: 'chat' | 'workshop';
  catalog: string;
  editing: string;
}): string {
  const sections = [TOOL_GUIDE];
  if (options.scope === 'workshop') {
    sections.push([
      '## Workshop mode',
      'You are editing one component for the user. Read the current state below, then call',
      '`update` with a full replacement and the component contract.',
      'On the first update, set a concise Chinese `name` (at most 20 characters) and a one-sentence',
      '`description`; the gallery shows both, and a component left as "未命名组件" is not useful.',
      'The user chose the design mode when creating it (stateful / display-only); follow it exactly:',
      'a stateful component must declare `stateSchema` and should declare `commands`, while a',
      'display-only component must not declare `stateSchema` and receives its data through `props`.',
      options.editing ? `\n${options.editing}` : '',
    ].filter(Boolean).join('\n'));
  } else if (options.catalog) {
    sections.push([
      '## Published components',
      'Use these exact ids. Prefer a stateful component (open/command) when the user wants to',
      'operate on a shared state; otherwise use render with props.',
      options.catalog,
    ].join('\n'));
  } else {
    sections.push('## Published components\nNo published components yet. Do not call render/open with a made-up id.');
  }
  sections.push(COMPONENT_CONTRACT);
  return sections.join('\n\n');
}

export { COMPONENT_CONTRACT, TOOL_GUIDE };
