import type { IncomingMessage, ServerResponse } from 'node:http';

export function handleInstanceModelProxy(request: IncomingMessage, response: ServerResponse, apiOrigin?: string): boolean;
