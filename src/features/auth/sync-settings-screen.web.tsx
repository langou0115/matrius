import { Redirect, type Href } from 'expo-router';
import { Bookmark, Check, Eye, FileText, Info, LoaderCircle, MessageSquare, Palette, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { SettingsPage } from '@/features/settings/settings-page.web';
import { useAuth } from './auth-state.web';
import {
  defaultSyncPreferences, loadSyncPreferences, saveSyncPreferences, syncCategories,
  type SyncCategoryId, type SyncPreferences,
} from './sync-preferences.web';

const categoryIcons: Record<SyncCategoryId, LucideIcon> = {
  conversations: MessageSquare,
  reading: Eye,
  personalization: Bookmark,
  appearance: Palette,
  files: FileText,
};

export default function SyncSettingsScreen() {
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const [preferences, setPreferences] = useState<SyncPreferences | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<SyncPreferences | null>(null);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    if (!userId) return;
    let active = true;
    loadSyncPreferences(userId).then((loaded) => {
      if (!active) return;
      latest.current = loaded;
      setPreferences(loaded);
    }).catch(() => {
      if (!active) return;
      const fallback = defaultSyncPreferences();
      latest.current = fallback;
      setPreferences(fallback);
      setError('无法读取已保存的同步设置，已恢复为全部开启。');
      setStatus('error');
    });
    return () => { active = false; };
  }, [userId]);

  function toggle(id: SyncCategoryId) {
    if (!userId || !latest.current) return;
    const next = { ...latest.current, [id]: !latest.current[id] };
    latest.current = next;
    setPreferences(next);
    setStatus('saving');
    setError(null);
    queue.current = queue.current
      .then(() => saveSyncPreferences(userId, next))
      .then(() => { if (latest.current === next) setStatus('saved'); })
      .catch(() => { setStatus('error'); setError('同步设置未能保存，请重试。'); });
  }

  // A direct load starts with an unverified token; wait for /me instead of bouncing the
  // account page before the session has had a chance to prove itself.
  if (auth.status === 'checking' && !auth.user) return <SettingsPage title="数据同步" description="换设备登录时，哪些内容跟着账号走。">
    <section className="settings-section">
      <p className="settings-footnote" role="status">正在验证账号…</p>
    </section>
  </SettingsPage>;
  if (!auth.user || auth.user.mustChangePassword) return <Redirect href={'/settings/account' as Href} />;

  const selected = preferences ? syncCategories.filter((category) => preferences[category.id]).length : 0;
  return <SettingsPage title="数据同步" description="换设备登录时，哪些内容跟着账号走。">
    <section className="settings-section" aria-labelledby="sync-content-heading">
      <h2 id="sync-content-heading">要同步什么</h2>
      <div className="sync-notice">
        <Info size={18} strokeWidth={1.75} aria-hidden="true" />
        <div>
          <strong>同步功能还没上线</strong>
          <p>现在先选好要同步的内容，选择会记在这个浏览器里。等功能上线，换台设备登录同一个账号就能自动带过去。</p>
        </div>
      </div>
      {!preferences
        ? <p className="settings-footnote" role="status">正在读取同步设置…</p>
        : <div className="sync-list">
          {syncCategories.map((category) => {
            const Glyph = categoryIcons[category.id];
            return <label className="sync-option" key={category.id}>
              <span className="sync-option-icon"><Glyph size={19} strokeWidth={1.75} aria-hidden="true" /></span>
              <span className="sync-option-copy">
                <strong>{category.title}</strong>
                <span>{category.description}</span>
              </span>
              <input className="model-checkbox-input" type="checkbox" checked={preferences[category.id]}
                onChange={() => toggle(category.id)} />
              <span className="model-checkbox" aria-hidden="true" />
            </label>;
          })}
        </div>}
      <p className="settings-footnote">模型 API Key、登录状态、输入框草稿和阅读位置不会同步。</p>
      <div className="sync-status" aria-live="polite">
        {status === 'saving' && <><LoaderCircle className="login-spinner" size={14} strokeWidth={2} aria-hidden="true" /><span>正在保存…</span></>}
        {status === 'saved' && <><Check size={14} strokeWidth={2} aria-hidden="true" /><span>已保存</span></>}
        {status === 'error' && <span className="model-form-error" role="alert">{error}</span>}
        {status === 'idle' && <span>已开启 {selected} 项，共 {syncCategories.length} 项</span>}
      </div>
    </section>
  </SettingsPage>;
}
