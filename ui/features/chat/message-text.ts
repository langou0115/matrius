import type { Message } from '@contract/agent-types';
import { stripUiBlockMarkers } from '@contract/intelligent-ui';

export function getCopyText(message: Pick<Message, 'role' | 'content' | 'quote'>): string {
  const body = message.role === 'assistant' ? stripUiBlockMarkers(message.content) : message.content;
  if (message.role !== 'user' || !message.quote?.trim()) return body;
  return `${message.quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n${body}`.trim();
}
