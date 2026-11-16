/**
 * UI workshop contract shared by `ui/` and `server/`.
 *
 * A component is a self-contained HTML fragment plus a JSON Schema for its
 * props. The fragment runs inside a sandboxed iframe with an opaque origin, so
 * this module owns the runtime protocol and the document composition on both
 * sides. It must stay free of Node, DOM, React and database imports: only types
 * and pure strings/functions.
 *
 * Versioning rules (see doc/ui-workshop.md):
 *   - a version is immutable and stored once;
 *   - messages and bindings reference a version number, never copy the code;
 *   - only published versions can be referenced;
 *   - publishing moves a pointer, it does not rewrite history.
 */

export const UI_COMPONENT_PROTOCOL_VERSION = 1;

/** Size guards. They are enforced on the server before anything is stored. */
export const UI_COMPONENT_MAX_HTML_CHARS = 200_000;
export const UI_COMPONENT_MAX_SCHEMA_CHARS = 20_000;
export const UI_COMPONENT_MAX_PROPS_CHARS = 64_000;
export const UI_COMPONENT_MAX_STATE_CHARS = 256_000;
export const UI_COMPONENT_MAX_ARTIFACTS = 8;
export const UI_COMPONENT_MAX_VERSIONS = 100;
export const UI_COMPONENT_MAX_DECLARATIONS = 20;

export type UiComponentStatus = 'draft' | 'published' | 'archived';
export type UiComponentVersionStatus = 'draft' | 'published';

export type UiComponentCommandDeclaration = {
  name: string;
  description?: string;
};

export type UiComponentEventDeclaration = {
  name: string;
  description?: string;
  /** When true the host offers a "交给 AI" action for this event. */
  toAgent?: boolean;
};

export type UiComponentVersionContent = {
  componentId: string;
  version: number;
  status: UiComponentVersionStatus;
  name: string;
  description: string;
  html: string;
  inputSchema: Record<string, unknown>;
  stateSchema?: Record<string, unknown> | null;
  commands: UiComponentCommandDeclaration[];
  events: UiComponentEventDeclaration[];
  protocolVersion: number;
};

/** What a single assistant message references after rendering a component. */
export type UiComponentArtifact = {
  componentId: string;
  version: number;
  name: string;
  /** Present when the component is stateful and a per-conversation binding exists. */
  bindingId?: string;
  /** Static props resolved by the model; stateful components keep data in `state`. */
  props?: unknown;
  /** Commands issued in the reply, used by the card to fetch and deliver them. */
  commandIds?: string[];
};

export type UiComponentSummary = {
  id: string;
  name: string;
  description: string;
  status: UiComponentStatus;
  currentVersion: number;
  publishedVersion: number | null;
  /** The creation-time choice: bound to a conversation and storing its own state. */
  stateful: boolean;
  conversationId: string | null;
  updatedAt: number;
  revision: number;
};

export type UiComponentVersionSummary = {
  version: number;
  status: UiComponentVersionStatus;
  name: string;
  createdAt: number;
};

/** Authoring change emitted while a workshop run writes a new version. */
export type UiComponentChange = {
  componentId: string;
  version: number;
  name: string;
  action: 'create' | 'update' | 'publish';
};

export type UiBindingCommand = {
  id: string;
  name: string;
  payload: unknown;
  status: 'pending' | 'applied' | 'failed';
  error?: string;
};

export type UiBindingSnapshot = {
  id: string;
  conversationId: string;
  componentId: string;
  version: number;
  /** Static props supplied when the binding was opened. */
  props: unknown;
  state: unknown;
  revision: number;
  pendingCommands: UiBindingCommand[];
  /** The version content is returned with the binding so the card needs one request. */
  content: UiComponentVersionContent;
};

export type UiComponentDetail = {
  component: UiComponentSummary;
  versions: UiComponentVersionSummary[];
};

export type UiThemeTokens = Record<string, string>;

/* -------------------------------------------------------------------------- */
/* iframe protocol                                                            */
/* -------------------------------------------------------------------------- */

export const UI_COMPONENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data: blob:",
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

export type UiHostMessage =
  | {
    type: 'matrius:init';
    props: unknown;
    state: unknown;
    theme: UiThemeTokens;
    locale: string;
    component: { componentId: string; version: number };
  }
  | { type: 'matrius:props'; props: unknown }
  | { type: 'matrius:state'; state: unknown }
  | { type: 'matrius:command'; id: string; name: string; payload: unknown };

export type UiFrameMessage =
  | { type: 'matrius:ready'; height?: number }
  | { type: 'matrius:resize'; height: number }
  | { type: 'matrius:state'; state: unknown }
  | { type: 'matrius:event'; name: string; payload?: unknown }
  | { type: 'matrius:command-result'; id: string; ok: boolean; error?: string; state?: unknown }
  | { type: 'matrius:error'; message: string; stack?: string };

const BASE_STYLE = `
:root {
  --matrius-background: #ffffff;
  --matrius-foreground: #111111;
  --matrius-card: #ffffff;
  --matrius-muted: #f2f2f2;
  --matrius-muted-foreground: #666666;
  --matrius-border: #dddddd;
  --matrius-primary: #1d9bf0;
}
html[data-color-mode='dark'] {
  --matrius-background: #1a1a1a;
  --matrius-foreground: #eeeeee;
  --matrius-card: #222222;
  --matrius-muted: #2a2a2a;
  --matrius-muted-foreground: #a0a0a0;
  --matrius-border: #3a3a3a;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 0; background: var(--matrius-background); }
body {
  color: var(--matrius-foreground);
  font-family: Inter, NotoSansSC, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
}
#root { display: block; min-height: 1px; padding: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
input, select, textarea { font: inherit; color: inherit; }
`;

/**
 * Fixed host bootstrap. It is injected after the AI-authored fragment so the
 * fragment can define `render` / `onCommand` in classic-script scope.
 *
 * The contract is intentionally small: `render(root, ctx)` is required,
 * `onCommand(name, payload, ctx)` is optional for stateful components, and
 * every outbound message goes through `MatriusUI`.
 */
const BOOTSTRAP = `
(function () {
  var post = function (message) {
    try { parent.postMessage(message, '*'); } catch (error) { /* host may be gone */ }
  };
  var report = function (error) {
    var message = error && error.message ? String(error.message) : String(error);
    post({
      type: 'matrius:error',
      message: message.slice(0, 2000),
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : ''
    });
  };
  window.addEventListener('error', function (event) {
    report(event.error || event.message || 'Unknown error');
  });
  window.addEventListener('unhandledrejection', function (event) {
    report(event.reason || 'Unhandled rejection');
  });
  var propsValue = null;
  var stateValue = null;
  var themeValue = {};
  function rootNode() { return document.getElementById('root'); }
  function resolveRender() {
    if (typeof window.render === 'function') return window.render;
    try { if (typeof render === 'function') return render; } catch (error) { /* TDZ, not defined yet */ }
    return null;
  }
  function resolveCommand() {
    if (typeof window.onCommand === 'function') return window.onCommand;
    try { if (typeof onCommand === 'function') return onCommand; } catch (error) { /* not defined */ }
    return null;
  }
  function measure() {
    var root = rootNode();
    if (!root) return;
    post({ type: 'matrius:resize', height: Math.ceil(root.getBoundingClientRect().height) });
  }
  function draw() {
    var root = rootNode();
    var render = resolveRender();
    if (!root) return;
    if (!render) { report(new Error('组件缺少 render(root, ctx) 函数。')); return; }
    try {
      root.replaceChildren();
      render(root, { props: propsValue, state: stateValue, theme: themeValue });
      measure();
    } catch (error) { report(error); }
  }
  var observer = null;
  function observe() {
    if (observer || typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver(function () { measure(); });
    var root = rootNode();
    if (root) observer.observe(root);
  }
  window.MatriusUI = {
    resize: measure,
    setState: function (state) {
      stateValue = state;
      post({ type: 'matrius:state', state: state });
    },
    emit: function (name, payload) {
      post({ type: 'matrius:event', name: String(name || 'event'), payload: payload === undefined ? null : payload });
    },
    commandResult: function (id, result) {
      result = result || {};
      post({
        type: 'matrius:command-result',
        id: String(id),
        ok: result.ok !== false,
        error: result.error ? String(result.error) : undefined,
        state: Object.prototype.hasOwnProperty.call(result, 'state') ? result.state : undefined
      });
    }
  };
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'matrius:init') {
      propsValue = data.props === undefined ? null : data.props;
      stateValue = data.state === undefined ? null : data.state;
      themeValue = data.theme || {};
      for (var key in themeValue) {
        if (/^[a-z][a-z-]*$/.test(key)) {
          document.documentElement.style.setProperty('--matrius-' + key, String(themeValue[key]));
        }
      }
      if (data.theme && data.theme.mode) document.documentElement.setAttribute('data-color-mode', String(data.theme.mode));
      observe();
      draw();
      var root = rootNode();
      post({ type: 'matrius:ready', height: root ? Math.ceil(root.getBoundingClientRect().height) : 0 });
      return;
    }
    if (data.type === 'matrius:props') { propsValue = data.props === undefined ? null : data.props; draw(); return; }
    if (data.type === 'matrius:state') { stateValue = data.state === undefined ? null : data.state; draw(); return; }
    if (data.type === 'matrius:command') {
      var handler = resolveCommand();
      if (!handler) {
        window.MatriusUI.commandResult(data.id, { ok: false, error: '组件未实现 onCommand。' });
        return;
      }
      try {
        var result = handler(String(data.name), data.payload, { props: propsValue, state: stateValue });
        Promise.resolve(result).then(function (value) {
          value = value || {};
          window.MatriusUI.commandResult(data.id, value);
        }, function (error) {
          window.MatriusUI.commandResult(data.id, { ok: false, error: error && error.message ? String(error.message) : String(error) });
        });
      } catch (error) {
        window.MatriusUI.commandResult(data.id, { ok: false, error: error && error.message ? String(error.message) : String(error) });
      }
    }
  });
  window.addEventListener('load', measure);
})();
`;

/**
 * Compose the sandboxed document. The AI-authored fragment is never treated as
 * a full document: the host supplies the CSP, the base styling and the bridge.
 */
export function composeUiComponentDocument(html: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${UI_COMPONENT_CSP}">`,
    `<style>${BASE_STYLE}</style>`,
    // The bridge loads before the authored fragment so parse/runtime errors in the fragment are
    // reported instead of leaving an empty frame until the timeout.
    `<script>${BOOTSTRAP}</script>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    html,
    '</body>',
    '</html>',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* validation helpers                                                         */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUiComponentArtifact(value: unknown): value is UiComponentArtifact {
  if (!isRecord(value)) return false;
  if (typeof value.componentId !== 'string' || value.componentId.length === 0 || value.componentId.length > 80) return false;
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) return false;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 200) return false;
  if (value.bindingId !== undefined && (typeof value.bindingId !== 'string' || value.bindingId.length > 80)) return false;
  if (value.commandIds !== undefined) {
    if (!Array.isArray(value.commandIds) || value.commandIds.length > 20) return false;
    if (!value.commandIds.every((id) => typeof id === 'string' && id.length <= 80)) return false;
  }
  return true;
}

/** Keep arbitrary JSON payloads inside the size guards before they reach SQLite. */
export function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function summarizeSchema(schema: Record<string, unknown> | null | undefined): string {
  if (!schema || !isRecord(schema.properties)) return '';
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
  return Object.keys(schema.properties)
    .slice(0, 24)
    .map((key) => (required.has(key) ? `${key}*` : key))
    .join(', ');
}

/** Prompt catalog: one compact line per published component. */
export function uiComponentCatalogText(entries: Array<{
  componentId: string;
  name: string;
  description: string;
  version: number;
  inputSchema: Record<string, unknown>;
  stateful: boolean;
}>): string {
  if (!entries.length) return '';
  return entries.map((entry) => {
    const props = summarizeSchema(entry.inputSchema);
    return [
      `- id: ${entry.componentId} — ${entry.name}（第 ${entry.version} 版，${entry.stateful ? '有状态，用 open/command' : '展示型，用 render'}）`,
      entry.description ? `  说明：${entry.description}` : '',
      props ? `  props 字段：${props}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}
