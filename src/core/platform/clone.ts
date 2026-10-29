/** Hermes may lack `structuredClone`; workspace snapshots are plain JSON, so a JSON
    round-trip is equivalent for every value this codebase stores. */
export function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through to JSON */ }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
