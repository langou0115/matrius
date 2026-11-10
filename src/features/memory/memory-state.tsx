import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import {
  MEMORY_SUMMARY_LIMIT,
  defaultMemoryPreferences,
  normalizeMemorySummary,
  readMemoryPreferences,
  type MemoryPreferences,
} from '@agent/core/memory';

type MemoryContextValue = MemoryPreferences & {
  setEnabled: (enabled: boolean) => void;
  /** Replace the whole summary. Returns false when the provider would reject the text. */
  replaceSummary: (summary: string) => boolean;
  clearSummary: () => void;
  /** Monotonic local revision, so a late background result cannot overwrite a manual edit. */
  revision: number;
};

function useMemoryState(initial: MemoryPreferences) {
  const [memory, setMemory] = useState(() => readMemoryPreferences(initial));
  const current = useRef(memory);
  const [revision, setRevision] = useState(0);

  const commit = useCallback((patch: Partial<MemoryPreferences>) => {
    const next = readMemoryPreferences({
      ...current.current,
      ...patch,
      ...(patch.summary !== undefined && patch.summary !== current.current.summary ? { updatedAt: Date.now() } : {}),
    });
    if (next.enabled === current.current.enabled && next.summary === current.current.summary
      && next.updatedAt === current.current.updatedAt) return false;
    current.current = next;
    setMemory(next);
    setRevision((value) => value + 1);
    return true;
  }, []);

  const setEnabled = useCallback((enabled: boolean) => { commit({ enabled }); }, [commit]);
  const replaceSummary = useCallback((summary: string) => {
    const normalized = normalizeMemorySummary(summary);
    if (normalized.length > MEMORY_SUMMARY_LIMIT) return false;
    return commit({ summary: normalized });
  }, [commit]);
  const clearSummary = useCallback(() => { commit({ summary: '' }); }, [commit]);

  return useMemo<MemoryContextValue>(() => ({
    enabled: memory.enabled,
    summary: memory.summary,
    updatedAt: memory.updatedAt,
    setEnabled,
    replaceSummary,
    clearSummary,
    revision,
  }), [clearSummary, memory, replaceSummary, revision, setEnabled]);
}

const MemoryContext = createContext<MemoryContextValue | null>(null);

export function MemoryProvider({ initialPreferences = defaultMemoryPreferences, children }: PropsWithChildren<{ initialPreferences?: MemoryPreferences }>) {
  return <MemoryContext value={useMemoryState(initialPreferences)}>{children}</MemoryContext>;
}

export function useMemory() {
  const value = useContext(MemoryContext);
  if (!value) throw new Error('MemoryProvider is required');
  return value;
}
