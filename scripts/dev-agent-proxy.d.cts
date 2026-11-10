import type { IncomingMessage, ServerResponse } from 'node:http';

/** Forwards `/api/agent` and `/api/copilotkit` to the local agent process during development. */
export function handleDevAgent(request: IncomingMessage, response: ServerResponse, target?: string): boolean;
