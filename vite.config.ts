import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import devAgentProxy from './scripts/dev-agent-proxy.cjs';
import devApiProxy from './scripts/dev-api-proxy.cjs';
import modelProxy from './scripts/model-proxy.cjs';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url)).replace(/\\/gu, '/');

const katexVersion = (JSON.parse(readFileSync(fromRoot('./node_modules/katex/package.json'), 'utf8')) as { version: string }).version;

/**
 * The development server answers first-party API and model traffic. The model relay
 * uses the shared stateless relay. Both handlers own the response
 * when they return true.
 */
function developmentMiddleware(): Plugin {
  return {
    name: 'matrius-development-middleware',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (devAgentProxy.handleDevAgent(request, response)) return;
        if (modelProxy.handleModelProxy(request, response)) return;
        if (devApiProxy.handleDevApi(request, response)) return;
        next();
      });
    },
  };
}

/**
 * KaTeX's stylesheet is copied to `public/vendor/katex/<version>` by the postinstall
 * script. Inject the link at build time so math renders before hydration and the
 * version never has to be duplicated in `index.html`.
 */
function katexStylesheet(): Plugin {
  return {
    name: 'matrius-katex-stylesheet',
    transformIndexHtml() {
      return [{
        tag: 'link',
        attrs: { rel: 'stylesheet', href: `/vendor/katex/${katexVersion}/katex.min.css` },
        injectTo: 'head',
      }];
    },
  };
}

/**
 * A production service worker registered on the same port would keep answering the
 * dev server's requests from its cache (and can serve an old shell that no longer
 * loads). Drop it before the app boots, not after.
 */
function dropStaleServiceWorker(): Plugin {
  return {
    name: 'matrius-drop-stale-service-worker',
    apply: 'serve',
    transformIndexHtml() {
      return [{
        tag: 'script',
        children: "if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((items) => items.forEach((item) => item.unregister()));",
        injectTo: 'head-prepend',
      }];
    },
  };
}

function offlineShell(): Plugin {
  return {
    name: 'matrius-offline-shell',
    apply: 'build',
    writeBundle(options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/')).sort();
      const revision = createHash('sha256').update(JSON.stringify(assets))
        .update(readFileSync(fromRoot('./public/sw.js')))
        .update(String(bundle['index.html']?.type === 'asset' ? bundle['index.html'].source : ''))
        .digest('hex').slice(0, 16);
      const worker = readFileSync(fromRoot('./public/sw.js'), 'utf8')
        .replace('matrius-v6', 'matrius-v6-' + revision)
        .replace('/* BUILD_ASSETS */', assets.map((name) => JSON.stringify('/' + name) + ',').join('\n'));
      writeFileSync(resolve(options.dir ?? 'dist', 'sw.js'), worker);
    },
  };
}

export default defineConfig({
  plugins: [offlineShell(), react(), developmentMiddleware(), katexStylesheet(), dropStaleServiceWorker()],
  resolve: {
    alias: [
      // pi 0.73.1's umbrella entry imports Node credential discovery and every provider.
      // Keep the browser bundle on our explicit three-provider adapter, as Metro did.
      { find: /^@mariozechner\/pi-ai$/u, replacement: fromRoot('./src/core/llm/pi-agent-bridge.ts') },
      { find: /^@\/assets\//u, replacement: fromRoot('./assets/') },
      { find: /^@\//u, replacement: fromRoot('./src/') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DEV_WEB_PORT ?? 8081),
    // A stale server on the configured port must fail loudly instead of moving to
    // another port that the API origin and the browser tab do not know about.
    strictPort: true,
    // Transform the first screen right after startup, so the browser's first load
    // does not pay for the whole module graph one request at a time.
    warmup: { clientFiles: ['./src/main.tsx', './src/router/routes.tsx'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
