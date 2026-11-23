import { WINDOWS_SHELL_OPTIONS, type WindowsTerminalShell } from '@contract/work-terminals';
import { AlertCircle, History, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SelectField } from '@/components/web/select-field';
import { useInstance } from '@/features/instance/instance-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { useIsPreview } from '@/features/workspace/preview-context';
import { listWorkTerminals } from './work-api';
import {
  loadWorkSettings,
  saveDefaultWindowsShell,
  savePersistTerminalScrollback,
} from './work-shell-preference';
import {
  detectPreviewPlatform,
  hydrateWorkSettings,
  isWindowsPlatform,
  setDefaultWindowsShell,
  setPersistTerminalScrollback,
  setWorkServerPlatform,
  useWorkState,
} from './work-state';

export function WorkGeneralScreen() {
  const instance = useInstance();
  const preview = useIsPreview();
  const { serverPlatform, defaultWindowsShell, persistTerminalScrollback } = useWorkState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canUseServer = !preview && instance.status === 'ready';
  const effectivePlatform = preview ? (serverPlatform ?? detectPreviewPlatform()) : serverPlatform;
  const windowsEnabled = isWindowsPlatform(effectivePlatform);

  useEffect(() => {
    if (preview) {
      if (serverPlatform === null) setWorkServerPlatform(detectPreviewPlatform());
      return;
    }
    if (!canUseServer) return;
    let cancelled = false;
    Promise.all([
      serverPlatform === null
        ? listWorkTerminals(instance.request).catch(() => null)
        : Promise.resolve(null),
      loadWorkSettings(instance.request).catch(() => null),
    ]).then(([terminalRes, workSettings]) => {
      if (cancelled) return;
      if (terminalRes?.platform) {
        setWorkServerPlatform(terminalRes.platform, terminalRes.windowsBuild ?? null);
      }
      if (workSettings) hydrateWorkSettings(workSettings);
    });
    return () => { cancelled = true; };
  }, [canUseServer, instance.request, preview, serverPlatform]);

  async function handleShellChange(value: string) {
    const nextShell = value as WindowsTerminalShell;
    setError(null);
    if (!windowsEnabled || saving) return;
    const previous = defaultWindowsShell;
    setDefaultWindowsShell(nextShell);
    if (preview) return;
    setSaving(true);
    try {
      const saved = await saveDefaultWindowsShell(instance.request, nextShell);
      setDefaultWindowsShell(saved);
    } catch (reason) {
      setDefaultWindowsShell(previous);
      setError(reason instanceof Error && reason.message ? reason.message : '保存默认终端失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleScrollbackChange(nextEnabled: boolean) {
    setError(null);
    if (saving) return;
    const previous = persistTerminalScrollback;
    setPersistTerminalScrollback(nextEnabled);
    if (preview) return;
    setSaving(true);
    try {
      const saved = await savePersistTerminalScrollback(instance.request, nextEnabled);
      setPersistTerminalScrollback(saved);
    } catch (reason) {
      setPersistTerminalScrollback(previous);
      setError(reason instanceof Error && reason.message ? reason.message : '保存终端历史输出设置失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage title="常规">
      <section className="settings-section" aria-labelledby="work-general-terminal-heading">
        <h2 id="work-general-terminal-heading">终端</h2>
        <div className="settings-list memory-settings-list work-settings-list">
          <div className="settings-row" id="work-default-terminal">
            <span className="settings-row-icon" aria-hidden="true">
              <Terminal size={19} strokeWidth={1.75} />
            </span>
            <div className="settings-row-copy">
              <strong>默认终端</strong>
              <span className="settings-row-description">
                {windowsEnabled
                  ? 'Windows 本机新建终端时默认打开 PowerShell 或 CMD。'
                  : '仅对 Windows 本机项目生效，当前主机使用系统 Shell。'}
              </span>
            </div>
            <div className="settings-row-action work-settings-control work-general-select-wrap">
              <SelectField
                label="默认终端"
                hideLabel
                value={defaultWindowsShell}
                disabled={!windowsEnabled || saving}
                options={WINDOWS_SHELL_OPTIONS}
                onChange={(value) => void handleShellChange(value)}
              />
            </div>
          </div>

          <div className="settings-row" id="work-terminal-scrollback">
            <span className="settings-row-icon" aria-hidden="true">
              <History size={19} strokeWidth={1.75} />
            </span>
            <div className="settings-row-copy">
              <strong>保留终端历史输出</strong>
              <span className="settings-row-description">
                开启后将节流保存终端输出快照，重启服务后恢复并回放历史内容。
              </span>
            </div>
            <label className="model-switch-label">
              <input
                className="model-checkbox-input"
                type="checkbox"
                checked={persistTerminalScrollback}
                disabled={saving}
                aria-label="保留终端历史输出"
                onChange={(event) => void handleScrollbackChange(event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden="true" />
            </label>
          </div>
        </div>
        {error && (
          <p className="settings-message is-error" role="alert">
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </section>
    </SettingsPage>
  );
}

export default WorkGeneralScreen;
