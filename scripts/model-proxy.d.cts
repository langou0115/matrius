import type { IncomingMessage, ServerResponse } from 'node:http';

/** Same-origin model relay shared by the Vite dev server and the production static server. */
export function handleModelProxy(request: IncomingMessage, response: ServerResponse): boolean;
