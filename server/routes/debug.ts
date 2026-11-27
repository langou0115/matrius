import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Settings } from '../config';
import { AppError } from '../errors';
import { openApiDocument } from '../openapi';
import type { FetchService } from '../services/fetch';
import type { SearchProviderStatus, SearchService } from '../services/search';

/**
 * Add a section here to grow `/debug`.
 */
export type DebugSection = {
  id: string;
  label: string;
  description: string;
  kind: 'health' | 'openapi';
};

export const DEBUG_SECTIONS: readonly DebugSection[] = [
  { id: 'health', label: '运行状态', description: 'Database, schema, storage and cache readiness', kind: 'health' },
  { id: 'openapi', label: 'OpenAPI 契约', description: 'Raw JSON for /api/openapi.json', kind: 'openapi' },
];

function sectionContent(section: DebugSection): string {
  if (section.kind === 'openapi') {
    return `
    <div class="toolbar">
      <button id="refresh-openapi" type="button">刷新</button>
      <a class="muted" href="/api/openapi.json" target="_blank" rel="noreferrer">GET /api/openapi.json</a>
    </div>
    <pre id="openapi-output">加载中…</pre>`;
  }
  return `
    <div class="toolbar">
      <button id="refresh-health" type="button">刷新</button>
      <span class="muted">GET /api/health/ready</span>
    </div>
    <pre id="health-output">加载中…</pre>`;
}

function debugHtml(): string {
  const nav = DEBUG_SECTIONS.map((section, index) => `
    <button class="nav-item${index === 0 ? ' active' : ''}" type="button" data-section="${section.id}">
      <span>${section.label}</span>
      <small>${section.description}</small>
    </button>`).join('');
  const panels = DEBUG_SECTIONS.map((section, index) => `
    <section class="panel${index === 0 ? ' active' : ''}" data-panel="${section.id}">
      <header class="panel-header">
        <h2>${section.label}</h2>
        <p>${section.description}</p>
      </header>
      ${sectionContent(section)}
    </section>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Matrius Debug</title>
  <style>
    :root { color-scheme: light dark; --bg:#f7f7f8; --panel:#fff; --text:#1f2328; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111315; --panel:#191c1f; --text:#e8eaed; --muted:#9aa0a6; --line:#2b3035; --accent:#7aa2ff; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .layout { display:flex; min-height:100vh; }
    .sidebar { width:260px; flex:0 0 260px; border-right:1px solid var(--line); background:var(--panel); padding:20px 14px; position:sticky; top:0; height:100vh; overflow:auto; }
    .brand { font-weight:700; font-size:16px; margin:0 6px 4px; }
    .brand-sub { color:var(--muted); font-size:12px; margin:0 6px 20px; }
    .nav-item { display:block; width:100%; text-align:left; border:0; background:transparent; color:var(--text); padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px; }
    .nav-item span { display:block; font-weight:600; }
    .nav-item small { display:block; color:var(--muted); font-size:11px; font-weight:400; margin-top:2px; }
    .nav-item:hover { background:color-mix(in srgb, var(--accent) 8%, transparent); }
    .nav-item.active { background:color-mix(in srgb, var(--accent) 14%, transparent); color:var(--accent); }
    .content { flex:1; min-width:0; padding:24px 28px 60px; }
    .panel { display:none; }
    .panel.active { display:block; }
    .panel-header h2 { margin:0 0 4px; font-size:20px; }
    .panel-header p { margin:0 0 18px; color:var(--muted); }
    .toolbar { display:flex; gap:10px; align-items:center; margin-bottom:12px; }
    .toolbar button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:6px; padding:6px 12px; cursor:pointer; }
    .muted { color:var(--muted); font-size:12px; }
    pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
    @media (max-width: 760px) { .layout { display:block; } .sidebar { width:auto; height:auto; position:static; border-right:0; border-bottom:1px solid var(--line); } .content { padding:18px; } }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <p class="brand">Matrius Debug</p>
      <p class="brand-sub">开发与排查工具</p>
      ${nav}
    </aside>
    <main class="content">${panels}</main>
  </div>
  <script>
    (function () {
      var buttons = Array.from(document.querySelectorAll('[data-section]'));
      var panels = Array.from(document.querySelectorAll('[data-panel]'));
      function loadJson(url, outputId) {
        var output = document.getElementById(outputId);
        if (!output) return;
        output.textContent = '加载中…';
        fetch(url, { cache: 'no-store' })
          .then(function (response) { return response.json().then(function (body) { return { status: response.status, body: body }; }); })
          .then(function (result) { output.textContent = JSON.stringify(result, null, 2); })
          .catch(function (error) { output.textContent = '请求失败：' + error; });
      }
      function activate(id) {
        var known = buttons.some(function (button) { return button.dataset.section === id; });
        if (!known) id = buttons[0] && buttons[0].dataset.section;
        buttons.forEach(function (button) { button.classList.toggle('active', button.dataset.section === id); });
        panels.forEach(function (panel) { panel.classList.toggle('active', panel.dataset.panel === id); });
        if (id === 'health') loadJson('/api/health/ready', 'health-output');
        if (id === 'openapi') loadJson('/api/openapi.json', 'openapi-output');
      }
      buttons.forEach(function (button) {
        button.addEventListener('click', function () { activate(button.dataset.section); history.replaceState(null, '', '#' + button.dataset.section); });
      });
      var refreshHealth = document.getElementById('refresh-health');
      if (refreshHealth) refreshHealth.addEventListener('click', function () { loadJson('/api/health/ready', 'health-output'); });
      var refreshOpenapi = document.getElementById('refresh-openapi');
      if (refreshOpenapi) refreshOpenapi.addEventListener('click', function () { loadJson('/api/openapi.json', 'openapi-output'); });
      activate((location.hash || '').replace('#', '') || 'health');
    })();
  </script>
</body>
</html>`;
}

const searchDebugSchema = z.object({
  query: z.string().trim().min(1, '请输入搜索关键词。').max(500),
  limit: z.number().int().min(1).max(30).default(10),
});

const fetchDebugSchema = z.object({
  url: z.string().trim().min(1, '请输入网页地址。').max(2000),
  mode: z.enum(['fast', 'full']).default('fast'),
});

function serializeToolError(reason: unknown): { code: string; message: string } {
  if (reason instanceof AppError) return { code: reason.code, message: reason.message };
  if (reason instanceof Error) {
    return {
      code: reason.name || 'tool_error',
      message: reason.message.replace(/\s+/gu, ' ').trim().slice(0, 500) || '工具调用失败。',
    };
  }
  return { code: 'tool_error', message: '工具调用失败。' };
}

export type DebugRouteDeps = {
  settings: Settings;
  search: SearchService;
  fetch: FetchService;
};

/**
 * `/debug` is a small development dashboard. API exploration is one section;
 * add entries to `DEBUG_SECTIONS` for future tools instead of creating another
 * top-level page. Disabled in production unless `ENABLE_DEBUG_PAGE=true`.
 */
export async function registerDebugRoutes(
  app: FastifyInstance,
  deps: DebugRouteDeps,
): Promise<void> {
  if (!deps.settings.enableDebugPage) return;

  app.get('/api/openapi.json', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return openApiDocument;
  });

  app.get('/debug', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return debugHtml();
  });

  app.post('/api/debug/tools/search', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { query, limit } = searchDebugSchema.parse(request.body ?? {});
    const startedAt = Date.now();
    try {
      const diagnostic = deps.search.diagnose
        ? await deps.search.diagnose(query, limit)
        : { results: await deps.search.searchMany([query], limit), providers: [] as SearchProviderStatus[] };
      return {
        ok: true,
        tool: 'search',
        tookMs: Math.max(0, Date.now() - startedAt),
        query,
        count: diagnostic.results.length,
        providers: diagnostic.providers,
        results: diagnostic.results,
      };
    } catch (error) {
      const providers = (error as { providers?: SearchProviderStatus[] } | null)?.providers;
      return {
        ok: false,
        tool: 'search',
        tookMs: Math.max(0, Date.now() - startedAt),
        query,
        ...(providers ? { providers } : {}),
        error: serializeToolError(error),
      };
    }
  });

  app.post('/api/debug/tools/fetch', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { url, mode } = fetchDebugSchema.parse(request.body ?? {});
    const startedAt = Date.now();
    try {
      const page = await deps.fetch.fetch(url, mode);
      return {
        ok: true,
        tool: 'fetch',
        tookMs: Math.max(0, Date.now() - startedAt),
        page,
      };
    } catch (error) {
      return {
        ok: false,
        tool: 'fetch',
        tookMs: Math.max(0, Date.now() - startedAt),
        url,
        error: serializeToolError(error),
      };
    }
  });
}
