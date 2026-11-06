import type { IncomingMessage, ServerResponse } from 'node:http';

/** Forwards `/api/` to the local FastAPI process during development. */
export function handleDevApi(request: IncomingMessage, response: ServerResponse, target?: string): boolean;
