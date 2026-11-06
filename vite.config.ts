import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import devApiProxy from './scripts/dev-api-proxy.cjs';
import modelProxy from './scripts/model-proxy.cjs';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url)).replace(/\\/gu, '/');

const katexVersion = (JSON.parse(readFileSync(fromRoot('./node_modules/katex/package.json'), 'utf8')) as { version: string }).version;

/**
 * The development server answers first-party API and model traffic, so `npm run web`
 * alone works for providers that reject browser CORS. Both handlers own the response
 * when they return true.
 */
function developmentMiddleware(): Plugin {
  return {
    name: 'matrius-development-middleware',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
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

export default defineConfig({
  plugins: [react(), developmentMiddleware(), katexStylesheet()],
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
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
