// Browser credentials are supplied explicitly by our session-only adapter.
// Never read build-machine environment variables into a client request.
export function getEnvApiKey(): undefined { return undefined; }
