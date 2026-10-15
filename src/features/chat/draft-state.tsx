import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';

function useDraftState() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = useCallback((key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);
  return useMemo(() => ({ drafts, setDraft }), [drafts, setDraft]);
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
