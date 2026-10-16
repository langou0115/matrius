const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// pi 0.73.1's umbrella entry imports Node credential discovery and every
// provider. Keep Expo's browser build on our explicit three-provider adapter.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    if (moduleName === '@mariozechner/pi-ai') {
      return { type: 'sourceFile', filePath: path.join(__dirname, 'src/core/llm/pi-agent-bridge.ts') };
    }
    if (context.originModulePath.includes('/@mariozechner/pi-ai/') && moduleName.endsWith('/env-api-keys.js')) {
      return { type: 'sourceFile', filePath: path.join(__dirname, 'src/core/llm/pi-browser-credentials.ts') };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
