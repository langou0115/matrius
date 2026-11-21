import { WINDOWS_SHELL_OPTIONS, type WindowsTerminalShell } from '@contract/work-terminals';
import { Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SelectField } from '@/components/web/select-field';
import { useInstance } from '@/features/instance/instance-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { useIsPreview } from '@/features/workspace/preview-context';
import { listWorkTerminals } from './work-api';
import { loadDefaultWindowsShell, saveDefaultWindowsShell } from './work-shell-preference';
import {
  detectPreviewPlatform,
  isWindowsPlatform,
  setDefaultWindowsShell,
  setWorkServerPlatform,
  useWorkState,
} from './work-state';

export function WorkGeneralScreen() {
  const instance = useInstance();
  const preview = useIsPreview();
  const { serverPlatform, defaultWindowsShell } = useWorkState();
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
      loadDefaultWindowsShell(instance.request).catch(() => null),
    ]).then(([terminalRes, shellPref]) => {
      if (cancelled) return;
      if (terminalRes?.platform) setWorkServerPlatform(terminalRes.platform);
      if (shellPref) setDefaultWindowsShell(shellPref);
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

  return (
    <SettingsPage title="常规">
      <section className="settings-section" id="work-default-terminal">
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="settings-list memory-settings-list">
          <div className="settings-row">
            <span className="settings-row-icon" aria-hidden="true">
              <Terminal size={18} strokeWidth={1.75} />
            </span>
            <div className="settings-row-copy">
              <strong>默认终端</strong>
              <span className="settings-row-description">
                {windowsEnabled
                  ? '仅对 Windows 本机项目生效；点击工作区右上角「+」时将默认打开此终端（PowerShell 或 CMD）。'
                  : '仅对 Windows 本机项目生效；当前主机的终端默认使用系统 Shell。'}
              </span>
            </div>
            <div className="settings-row-action work-general-select-wrap">
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
        </div>
      </section>
    </SettingsPage>
  );
}

export default WorkGeneralScreen;
