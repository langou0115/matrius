import type { CSSProperties } from 'react';

import { Icon } from '@/components/web/icon';
import { BrandMark } from '@/components/web/brand-mark';
import { useResolvedColorMode } from '@/components/web/app-frame';
import { resolveTheme } from '@/theme/resolve-theme';
import { useAppearance } from '@/theme/appearance';
import { themePresets } from '@/theme/presets';

import { SettingsPage } from './settings-page';
import { displayModes } from './settings-catalog';

export function AppearanceSettingsScreen() {
  const { mode, setMode, themeId, setThemeId } = useAppearance();
  const resolvedMode = useResolvedColorMode();
  return <SettingsPage title="外观" description="调整显示模式与配色主题。">
    <section className="settings-section" aria-labelledby="display-heading">
      <h2 id="display-heading">显示模式</h2>
      <div className="settings-mode-row">
        <div className="mode-switch settings-mode-switch" role="group" aria-label="显示模式">{displayModes.map((item) => <button key={item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}><Icon name={item.icon} size={17} /><span>{item.label}</span></button>)}</div>
      </div>
    </section>
    <section className="settings-section" aria-labelledby="theme-heading">
      <h2 id="theme-heading">配色主题</h2>
      <div className="theme-grid settings-theme-grid">{themePresets.map((preset) => {
        const colors = resolveTheme(preset, resolvedMode);
        return <button key={preset.id} className={`theme-card ${themeId === preset.id ? 'is-selected' : ''}`} aria-pressed={themeId === preset.id} onClick={() => setThemeId(preset.id)}>
          <span className="theme-preview" style={{ '--preview-bg': colors.background, '--preview-sidebar': colors.sidebar, '--preview-primary': colors.primary, '--preview-muted': colors.muted, '--preview-fg': colors.foreground } as CSSProperties}>
            <span className="preview-sidebar"><i /><i /><i /></span><span className="preview-content"><i /><i /><span><i /></span></span>
          </span>
          <span className="theme-card-label">{preset.name}<span className="theme-check">{themeId === preset.id && <Icon name="check" size={13} />}</span></span>
        </button>;
      })}</div>
    </section>
  </SettingsPage>;
}

export function AboutSettingsScreen() {
  return <SettingsPage title="关于 Matrius" description="应用信息与实例存储说明。">
      <section className="settings-section" aria-labelledby="about-heading"><h2 id="about-heading">关于</h2>
        <div className="about-card"><span className="about-logo"><BrandMark size={38} /></span><div><h3>Matrius</h3><p>一个安静、自由的 AI 对话空间。</p></div><span className="version-label">v1.0.0</span></div>
      </section>
  </SettingsPage>;
}
