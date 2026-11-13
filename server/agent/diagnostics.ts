import { randomUUID } from 'node:crypto';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

import type { ModelConfig } from './llm/model-config';
import type { ReplyResult } from './types';

type Entry = { event: string; at: string; [key: string]: unknown };
type Trace = { id: string; model: string; protocol: string; thinkingEffort: string; configuredMaxOutput: number; entries: Entry[] };
const traces: Trace[] = [];
const MAX_RUNS = 20;
const MAX_ENTRIES = 100;

/** Metadata only: never retain request bodies, headers, keys, text or tool arguments. */
export const replyDiagnostics = Object.freeze({
  export: () => JSON.stringify({ version: 1, runs: traces }, null, 2),
  clear: () => { traces.length = 0; },
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createReplyDiagnostics(config: ModelConfig, thinkingEffort: string) {
  const trace: Trace = {
    id: randomUUID(), model: config.modelId, protocol: config.protocol,
    thinkingEffort, configuredMaxOutput: config.maxOutput, entries: [],
  };
  traces.push(trace);
  if (traces.length > MAX_RUNS) traces.shift();
  function record(event: string, fields: Record<string, unknown>) {
    trace.entries.push({ event, at: new Date().toISOString(), ...fields });
    if (trace.entries.length > MAX_ENTRIES) trace.entries.shift();
  }
  let round = 0;
  return {
    stream(streamFn: StreamFn): StreamFn {
      return (model, context, options) => {
        const request = ++round;
        record('request', { round: request, requestedMaxTokens: number(options?.maxTokens) });
        return streamFn(model, context, {
          ...options,
          async onPayload(payload, requestModel) {
            const replacement = await options?.onPayload?.(payload, requestModel);
            const body = object(replacement === undefined ? payload : replacement);
            record('payload_limits', {
              round: request,
              maxTokens: number(body.max_tokens), maxCompletionTokens: number(body.max_completion_tokens),
              maxOutputTokens: number(body.max_output_tokens), thinkingBudget: number(object(body.thinking).budget_tokens),
            });
            return replacement;
          },
          async onResponse(response, requestModel) {
            const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
            const requestId = headers['x-request-id'] ?? headers['request-id'] ?? headers['x-correlation-id'];
            record('response', {
              round: request, status: response.status,
              requestId: requestId && /^[\w.:-]{1,160}$/.test(requestId) ? requestId : undefined,
            });
            await options?.onResponse?.(response, requestModel);
          },
        });
      };
    },
    messageEnd(message: AssistantMessage) {
      record('message_end', {
        round, stopReason: message.stopReason,
        // SDKs can reject non-2xx responses before invoking onResponse. Keep
        // only a leading HTTP error code, never their possibly sensitive body.
        httpErrorStatus: number(Number(/^\s*([45]\d\d)\b/.exec(message.errorMessage ?? '')?.[1] ?? NaN)),
        blockTypes: message.content.slice(0, 50).map((block) => block.type),
        textChars: message.content.reduce((count, block) => count + (block.type === 'text' ? block.text.length : 0), 0),
        thinkingChars: message.content.reduce((count, block) => count + (block.type === 'thinking' ? block.thinking.length : 0), 0),
        toolCalls: message.content.filter((block) => block.type === 'toolCall').length,
        usage: {
          input: number(message.usage.input), output: number(message.usage.output),
          cacheRead: number(message.usage.cacheRead), cacheWrite: number(message.usage.cacheWrite),
          totalTokens: number(message.usage.totalTokens),
        },
        providerDiagnosticCount: message.diagnostics?.length ?? 0,
      });
    },
    toolEnd(isError: boolean) { record('tool_end', { round, isError }); },
    /** A reply was cut off without any body text; the runner retries with less thinking. */
    outputRetry(attempt: number, thinkingLevel: string) { record('output_retry', { attempt, thinkingLevel }); },
    finish(result: ReplyResult, outcome: string): ReplyResult {
      record('finish', { status: result.status, outcome, rounds: round });
      // Serialize now so DevTools cannot show later mutations of a live object.
      console.info('[Matrius Agent]', JSON.stringify(trace));
      return result;
    },
  };
}
