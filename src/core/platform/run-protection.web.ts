type RefreshClient = { disable(): void; enable(): void };

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
      clearTimeout(resumeTimer);
      if (active && refresh && !paused) {
        try { refresh.disable(); paused = true; }
        catch { console.warn('未能暂停开发热更新；生成期间请避免修改源代码。'); }
      } else if (!active) resumeLater();
    },
    dispose() {
      active = false;
      target?.removeEventListener('beforeunload', beforeUnload);
      clearTimeout(resumeTimer);
      resumeLater();
    },
  };
}

export function protectBrowserRun() {
  let refresh: RefreshClient | undefined;
  if (typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_OS === 'web') {
    // SDK 57's own HMR toggle queues updates while disabled. Keep the private
    // integration isolated here and recheck it when upgrading Expo.
    let client: RefreshClient | undefined;
    let paused = false;
    refresh = {
      disable() { paused = true; client?.disable(); },
      enable() { paused = false; client?.enable(); },
    };
    void import('./dev-refresh-client.web').then((module) => module.loadDevelopmentRefreshClient()).then((value) => {
      client = value;
      if (paused) client.disable();
    }).catch(() => console.warn('未能连接开发热更新控制器；生成期间请避免修改源代码。'));
  }
  return createRunProtection({ target: typeof window === 'undefined' ? undefined : window, refresh });
}
