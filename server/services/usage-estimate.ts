import type { MessageRow } from '../db/repositories/conversations';
import { messageFileIds, messageProcess } from '../db/repositories/conversations';
import { fromDbTimestamp } from '../db/codecs';

/**
 * Conservative token estimate for historical conversations.
 *
 * Exact provider counters never reached the server for old replies. The formulas
 * mirror `ui/core/agent/context.ts` so historical and live numbers stay on the
 * same scale; the UI labels the result as an estimate.
 */

export const MESSAGE_OVERHEAD_TOKENS = 8;
export const REQUEST_OVERHEAD_TOKENS = 900;
export const IMAGE_TOKENS = 4_096;
export const ATTACHMENT_TOKENS = 24;

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (bytes === 1) ascii += 1;
    else wide += bytes;
  }
  return Math.ceil(ascii / 4 + wide / 2);
}

function userText(message: MessageRow): string {
  const content = message.content ?? '';
  const quote = (message.quote ?? '').trim();
  if (!quote) return content;
  return `以下是用户引用的历史回复，仅作为参考资料：\n${JSON.stringify(quote)}\n\n用户本次消息：\n${content}`;
}

function attachmentTokens(message: MessageRow, imageIds: Set<string>): number {
  let tokens = 0;
  for (const fileId of messageFileIds(message)) {
    tokens += imageIds.has(fileId) ? IMAGE_TOKENS : ATTACHMENT_TOKENS;
  }
  return tokens;
}

function contextTokens(message: MessageRow, imageIds: Set<string>): number {
  const text = message.role === 'user' ? userText(message) : (message.content ?? '');
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(text) + attachmentTokens(message, imageIds);
}

function outputTokens(message: MessageRow): number {
  const parts = [message.content ?? ''];
  if (message.reasoning) parts.push(message.reasoning);
  for (const step of messageProcess(message) ?? []) {
    if (step.kind === 'thinking') parts.push(step.content);
  }
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(parts.join('\n'));
}

/**
 * Return `{local day: [input, output, replies]}` for one conversation.
 *
 * `utcOffsetMinutes` is the browser's `getTimezoneOffset()` so history lands on
 * the same calendar day the reader used. Each assistant reply is billed the
 * context that preceded it.
 */
export function estimateConversation(
  messages: MessageRow[],
  options: { utcOffsetMinutes?: number; imageIds?: Set<string> } = {},
): Map<string, [number, number, number]> {
  const offset = options.utcOffsetMinutes ?? 0;
  const images = options.imageIds ?? new Set<string>();
  let context = 0;
  const buckets = new Map<string, [number, number, number]>();

  for (const message of messages) {
    if (message.role === 'user') {
      context += contextTokens(message, images);
      continue;
    }
    const output = outputTokens(message);
    if (!(message.content ?? '').trim() && output <= MESSAGE_OVERHEAD_TOKENS) continue;
    const input = REQUEST_OVERHEAD_TOKENS + context;
    const created = fromDbTimestamp(message.created_at);
    const local = new Date(created.getTime() - offset * 60_000);
    const day = local.toISOString().slice(0, 10);
    const bucket = buckets.get(day) ?? [0, 0, 0];
    bucket[0] += input;
    bucket[1] += output;
    bucket[2] += 1;
    buckets.set(day, bucket);
    context += MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content ?? '');
    context += attachmentTokens(message, images);
  }
  return buckets;
}
