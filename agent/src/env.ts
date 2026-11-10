/** Agent service configuration. Everything is loopback by default: the browser reaches
 *  this process through the dev proxy, and the process reaches the API on the same host. */
export const config = {
  host: process.env.AGENT_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_PORT ?? 8123),
  /** Python API origin used for tools and persistence. */
  apiBaseUrl: (process.env.MATRIUS_API_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/u, ''),
  /** Keep-alive comment interval for proxied SSE responses. */
  heartbeatMs: 15_000,
};

export function log(message: string): void {
  process.stdout.write(`[agent] ${message}\n`);
}
