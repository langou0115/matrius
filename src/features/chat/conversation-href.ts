import type { Href } from 'expo-router';

export function conversationHref(id: string | null, preview = false): Href {
  const root = preview ? '/mock/chat' : '';
  return (id ? `${root}/c/${encodeURIComponent(id)}` : root || '/') as Href;
}
