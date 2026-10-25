// SDK 57 private integration. Keep it in JS so TypeScript does not pull Expo's
// native WebView type graph into this Web-only development adapter.
export async function loadDevelopmentRefreshClient() {
  const { default: client } = await import('expo/src/async-require/hmr');
  return client;
}
