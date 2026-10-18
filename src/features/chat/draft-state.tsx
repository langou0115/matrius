import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';

function useDraftState() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [quotes, setQuotes] = useState<Record<string, string>>({});
  const setQuote = useCallback((key: string, value: string) => {
    setQuotes((current) => ({ ...current, [key]: value }));
  }, []);
  const setDraft = useCallback((key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);
  return useMemo(() => ({ drafts, setDraft, quotes, setQuote }), [drafts, setDraft, quotes, setQuote]);
}
const DraftContext = createContext<ReturnType<typeof useDraftState> | null>(null);

export function DraftProvider({ children }: PropsWithChildren) {
  return <DraftContext value={useDraftState()}>{children}</DraftContext>;
}

export function useDrafts() {
  const value = useContext(DraftContext);
  if (!value) throw new Error('DraftProvider is required');
  return value;
}
