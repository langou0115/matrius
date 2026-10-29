/** Native apps have no beforeunload or HMR-reload lifecycle; keep the shared runtime's
    calls harmless and return the same shape as the web implementation. */
export function hasActiveBrowserRun() {
  return false;
}

export function createRunProtection(_options: {
  target?: unknown;
  refresh?: { disable(): void; enable(): void };
  resumeDelayMs?: number;
} = {}) {
  return { setActive(_value: boolean) {}, dispose() {} };
}

export function protectBrowserRun() {
  return createRunProtection();
}
