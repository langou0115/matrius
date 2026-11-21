import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** Forwards `/api/` to the local Node API process during development. */
export function handleDevApi(request: IncomingMessage, response: ServerResponse, target?: string): boolean;

/** Forwards `/api/` WebSocket upgrade connections to the local Node API process during development. */
export function handleDevUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, target?: string): boolean;
