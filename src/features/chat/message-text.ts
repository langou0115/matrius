import type { Message } from '@/core/agent/types';

export function getCopyText(message: Pick<Message, 'role' | 'content' | 'quote'>): string {
  if (message.role !== 'user' || !message.quote?.trim()) return message.content;
  return `${message.quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n${message.content}`.trim();
}
