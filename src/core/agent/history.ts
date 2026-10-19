import type { Message } from './types';

/**
 * A failed turn is an error report, not an answer the model gave. Replaying it would let a partial
 * reply masquerade as a completed one, so it is dropped from every request history — retry, the
 * next message, and the size estimate alike.
 */
export function withoutFailedReplies(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== 'assistant' || message.status !== 'error');
}

/**
 * A new message supersedes a failed turn entirely, matching the conversation the user meant to
 * have: both the unanswered question and its error report are dropped. (Retry keeps the question,
 * because that is the message being sent again.)
 */
export function withoutFailedTurn(messages: Message[]): Message[] {
  const history = withoutFailedReplies(messages);
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.status !== 'error') return history;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === 'user') return history.filter((_, position) => position !== index);
  }
  return history;
}
