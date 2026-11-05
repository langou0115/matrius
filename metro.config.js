const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { handleModelProxy } = require('./scripts/model-proxy.cjs');
const { handleDevApi } = require('./scripts/dev-api-proxy.cjs');
const { handleStaticMiss } = require('./scripts/static-guard.cjs');

// SDK 57's lazy chunk registration can force a page reload after Metro loses
// its HMR graph. Eager dev bundles avoid fetching/registering a new chunk in
// the middle of a tool-using reply. Production exports keep normal splitting.
if (process.env.NODE_ENV !== 'production') process.env.EXPO_NO_METRO_LAZY ??= '1';

const config = getDefaultConfig(__dirname);

// Metro crawls and watches every file under the project root. The Python
// environment, the API's SQLite data and the dev server's own logs are not part
// of the web bundle; on Windows (no Watchman) they add thousands of watch
// handles and a steady stream of change events, which is where long dev-server
// stalls come from. `dev/` stays watched: the Mock routes import it.
//
// The patterns must be anchored at this directory. Metro also applies the
// blockList to module resolution, so a bare /dist/ (or /server/, /doc/) would
// match node_modules packages that ship the same folder name — for example
// react-native-web/dist, which every bundle imports.
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const rootPattern = escapePattern(__dirname).replace(/\\\\/gu, '[\\\\/]');
const notBundled = ['server', '\\.expo', 'doc', 'tests', 'dist']
  .map((entry) => new RegExp(`^${rootPattern}[\\\\/]${entry}[\\\\/]`));
config.resolver.blockList = [config.resolver.blockList, ...notBundled].flat().filter(Boolean);

// Serve the same-origin model relay from the dev server, so `npm run web` alone is enough
// for providers that reject browser CORS. Must be registered before returning the config.
const previousEnhanceMiddleware = config.server?.enhanceMiddleware;
config.server = {
  ...config.server,
  enhanceMiddleware(middleware, server) {
    const enhanced = previousEnhanceMiddleware ? previousEnhanceMiddleware(middleware, server) : middleware;
    return function modelProxyMiddleware(req, res, next) {
      if (handleModelProxy(req, res)) return;
      if (handleDevApi(req, res)) return;
      // An unknown public asset otherwise falls through to the SPA and returns index.html
      // with a 200, so a broken icon shows nothing and logs nothing. Make that a 404.
      if (process.env.NODE_ENV !== 'production' && handleStaticMiss(req, res, path.join(__dirname, 'public'))) return;
      return enhanced(req, res, next);
    };
  },
};

// pi 0.73.1's umbrella entry imports Node credential discovery and every
// provider. Keep Expo's browser build on our explicit three-provider adapter.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    if (moduleName === '@mariozechner/pi-ai') {
      return { type: 'sourceFile', filePath: path.join(__dirname, 'src/core/llm/pi-agent-bridge.ts') };
    }
    if (context.originModulePath.replace(/\\/g, '/').includes('/@mariozechner/pi-ai/') && moduleName.endsWith('/env-api-keys.js')) {
      return { type: 'sourceFile', filePath: path.join(__dirname, 'src/core/llm/pi-browser-credentials.ts') };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
