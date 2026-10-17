import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

import { defaultPersonalization, readPersonalization, type PersonalizationPreferences } from './personalization';

function usePersonalizationState(initial: PersonalizationPreferences) {
  const [preferences, setPreferences] = useState(() => readPersonalization(initial));
  return useMemo(() => ({ preferences, update(patch: Partial<PersonalizationPreferences>) {
    setPreferences((current) => readPersonalization({ ...current, ...patch }));
  } }), [preferences]);
}
const PersonalizationContext = createContext<ReturnType<typeof usePersonalizationState> | null>(null);
export function PersonalizationProvider({ initialPreferences = defaultPersonalization, children }: PropsWithChildren<{ initialPreferences?: PersonalizationPreferences }>) {
  return <PersonalizationContext value={usePersonalizationState(initialPreferences)}>{children}</PersonalizationContext>;
}
export function usePersonalization() {
  const value = useContext(PersonalizationContext);
  if (!value) throw new Error('PersonalizationProvider is required');
  return value;
}
