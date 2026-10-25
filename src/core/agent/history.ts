import type { Message } from './types';

/** Exclude empty error placeholders, while retaining partial prose users can continue. */
export function withoutFailedReplies(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== 'assistant' || message.status !== 'error' || Boolean(message.content.trim()));
}
