import type { Message } from '@/core/agent/types';

/** Server positions follow append order, so a steering message saved after the reply it
    interrupted sits behind that reply on reload. Move each one back in front of the nearest
    preceding assistant message; already-normalized lists are left untouched. */
export function orderSteeringMessages(messages: Message[]): Message[] {
  if (!messages.some((message) => message.steering)) return messages;
  const ordered: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user' && message.steering) {
      let index = ordered.length - 1;
      while (index >= 0 && ordered[index].role !== 'assistant') index--;
      if (index >= 0) {
        ordered.splice(index, 0, message);
        continue;
      }
    }
    ordered.push(message);
  }
  return ordered;
}
