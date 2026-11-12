import { useSyncExternalStore } from 'react';

/** Device-level display switches for the process transcript. They describe how this browser shows
    a reply, so they live beside the other device state instead of the server-backed profile. */
export type ChatDisplayPreferences = {
  /** Thinking segments start open instead of folding into their one-line teaser. */
  thinkingExpanded: boolean;
  /** Render thinking segments at all; off leaves only the tool calls in the process. */
  showThinking: boolean;
};

export const defaultChatDisplay: ChatDisplayPreferences = { thinkingExpanded: true, showThinking: true };

const storageKey = 'matrius.chat-display.v1';

function readStored(): ChatDisplayPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return { ...defaultChatDisplay };
    const value = JSON.parse(raw) as Partial<Record<keyof ChatDisplayPreferences, unknown>>;
    return {
      thinkingExpanded: typeof value.thinkingExpanded === 'boolean' ? value.thinkingExpanded : defaultChatDisplay.thinkingExpanded,
      showThinking: typeof value.showThinking === 'boolean' ? value.showThinking : defaultChatDisplay.showThinking,
    };
  } catch {
    return { ...defaultChatDisplay };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export function getChatDisplay(): ChatDisplayPreferences {
  return current;
}

export function setChatDisplay(patch: Partial<ChatDisplayPreferences>): void {
  if (patch.thinkingExpanded === undefined && patch.showThinking === undefined) return;
  const next = { ...current, ...patch };
  if (next.thinkingExpanded === current.thinkingExpanded && next.showThinking === current.showThinking) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode); the switch still works for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatDisplay(): ChatDisplayPreferences {
  return useSyncExternalStore(subscribe, getChatDisplay, getChatDisplay);
}
