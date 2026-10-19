const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { handleModelProxy } = require('./scripts/model-proxy.cjs');

const config = getDefaultConfig(__dirname);

// Serve the same-origin model relay from the dev server, so `npm run web` alone is enough
// for providers that reject browser CORS. Must be registered before returning the config.
const previousEnhanceMiddleware = config.server?.enhanceMiddleware;
config.server = {
  ...config.server,
  enhanceMiddleware(middleware, server) {
    const enhanced = previousEnhanceMiddleware ? previousEnhanceMiddleware(middleware, server) : middleware;
    return function modelProxyMiddleware(req, res, next) {
      if (handleModelProxy(req, res)) return;
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
