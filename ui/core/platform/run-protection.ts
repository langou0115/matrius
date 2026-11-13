type RefreshClient = { disable(): void; enable(): void };

let activeRuns = 0;

/** Whether a live generation still needs this page to stay mounted. */
export function hasActiveBrowserRun() {
  return activeRuns > 0;
}

/** Keep code edits and accidental navigation from silently destroying a live request. */
export function createRunProtection({ target, refresh, resumeDelayMs = 1500 }: {
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  refresh?: RefreshClient;
  resumeDelayMs?: number;
}) {
  let active = false;
  let paused = false;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!active) return;
    event.preventDefault();
    event.returnValue = '';
  };
  target?.addEventListener('beforeunload', beforeUnload);
  function resumeLater() {
    if (!paused) return;
    // Let the final React commit and queued IndexedDB writes settle before an
    // accumulated code update is allowed to remount/reload the page.
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (active) return;
      try { refresh?.enable(); }
      catch { console.warn('开发热更新连接已失效；可在回复结束后手动刷新页面。'); }
      paused = false;
    }, resumeDelayMs);
  }
  return {
    setActive(value: boolean) {
      if (value === active) return;
      active = value;
      activeRuns += value ? 1 : -1;
      clearTimeout(resumeTimer);
      if (active && refresh && !paused) {
        try { refresh.disable(); paused = true; }
        catch { console.warn('未能暂停开发热更新；生成期间请避免修改源代码。'); }
      } else if (!active) resumeLater();
    },
    dispose() {
      if (active) activeRuns = Math.max(0, activeRuns - 1);
      active = false;
      target?.removeEventListener('beforeunload', beforeUnload);
      clearTimeout(resumeTimer);
      resumeLater();
    },
  };
}

export function protectBrowserRun() {
  // Vite's hot updates keep this page mounted, so only a manual reload or a full
  // rebuild reload can interrupt a live reply; `beforeunload` asks before that happens.
  return createRunProtection({ target: typeof window === 'undefined' ? undefined : window });
}
