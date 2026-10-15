import { Link } from 'expo-router';
import { LinkAnchor } from '@/components/web/link-anchor';
import type { CSSProperties } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import { useResolvedColorMode } from '@/components/web/app-frame';
import { resolveTheme } from '@/theme/resolve-theme';
import { useAppearance, type ColorMode } from '@/theme/appearance';
import { themePresets } from '@/theme/presets';

const modes: { id: ColorMode; label: string; icon: IconName }[] = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
];

export default function SettingsScreen() {
  const { themeId, setThemeId, mode, setMode } = useAppearance();
  const resolvedMode = useResolvedColorMode();
  return <main className="settings-main" id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      <Link href="/" asChild><LinkAnchor className="settings-back"><Icon name="back" size={18} />返回对话</LinkAnchor></Link>
    </header>
    <div className="settings-scroll"><div className="settings-content">
      <div className="settings-heading"><span className="eyebrow">让这里更像你</span><h1>设置</h1><p>调整你的对话空间，找到最舒适的样子。</p></div>
      <section className="settings-section" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">外观</h2>
        <div className="settings-row"><div><h3>显示模式</h3><p>为白天和夜晚，选择合适的亮度。</p></div>
          <div className="mode-switch" role="group" aria-label="显示模式">{modes.map((item) => <button key={item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}><Icon name={item.icon} size={17} /><span>{item.label}</span></button>)}</div>
        </div>
        <div className="theme-heading"><h3>配色主题</h3><p>换一种心情，布局与字体保持熟悉。</p></div>
        <div className="theme-grid">{themePresets.map((preset) => {
          const preview = resolveTheme(preset, resolvedMode);
          return <button key={preset.id} className={`theme-card ${themeId === preset.id ? 'is-selected' : ''}`} aria-pressed={themeId === preset.id} onClick={() => setThemeId(preset.id)}>
          <span className="theme-preview" style={{ '--preview-bg': preview.background, '--preview-sidebar': preview.sidebar, '--preview-primary': preview.primary, '--preview-muted': preview.muted, '--preview-fg': preview.foreground } as CSSProperties}>
            <span className="preview-sidebar"><i /><i /><i /></span><span className="preview-content"><i /><i /><span><i /></span></span>
          </span>
          <span className="theme-card-label">{preset.name}<span className="theme-check">{themeId === preset.id && <Icon name="check" size={13} />}</span></span>
        </button>;
        })}</div>
        <p className="settings-footnote">外观偏好会自动保存在当前浏览器中。</p>
      </section>
      <section className="settings-section" aria-labelledby="about-heading"><h2 id="about-heading">关于</h2>
        <div className="about-card"><span className="about-logo"><Icon name="sparkle" size={23} /></span><div><h3>Matrius</h3><p>一个安静、自由的 AI 对话空间。</p></div><span className="version-label">v1.0.0</span></div>
        <div className="about-row"><span>运行模式</span><span><Icon name="shield" size={15} />本地模式</span></div>
        <p className="settings-footnote">无需登录即可使用。对话保存在当前浏览器中，刷新后仍可查看；清除网站数据会删除本地记录。</p>
      </section>
    </div></div>
  </main>;
}
