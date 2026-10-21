import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuth, useFeature } from '@/features/auth/auth-state.web';
import { ApiError } from '@/core/api/auth-session';
import { SettingsPage } from './settings-page.web';

type Feature = { id: string; name: string; description: string; stage: 'preview' | 'stable' };

function AuthorizedLabs() {
  const auth = useAuth();
  const { request, refresh } = auth;
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    request<{ features: Feature[] }>('/api/features/labs', { signal: abort.signal }).then((result) => {
      if (active) setFeatures(result.features);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError('暂时无法获取已开放的功能，请重试。');
      if (reason instanceof ApiError && reason.status === 403) void refresh();
    });
    return () => { active = false; abort.abort(); };
  }, [attempt, request, refresh]);
  return <SettingsPage title="实验功能" description="提前体验当前账号已开放的新功能。">
    <section className="settings-section" aria-labelledby="labs-heading"><h2 id="labs-heading">当前可用</h2>
      {!features && !error && <p className="settings-footnote" role="status">正在获取功能…</p>}
      {features?.map((feature) => <div className="settings-row" key={feature.id}><div><h3>{feature.name}</h3><p>{feature.description}</p></div><span className="settings-footnote">{feature.stage === 'preview' ? '测试中' : '已验证'}</span></div>)}
      {error && <><p className="model-form-error" role="alert">{error}</p><button className="secondary-button" onClick={() => { setError(null); setFeatures(null); setAttempt((value) => value + 1); }}>重试</button></>}
    </section>
  </SettingsPage>;
}

export default function LabsScreen() {
  const auth = useAuth();
  const enabled = useFeature('labs');
  if (auth.status === 'checking') return <SettingsPage title="设置" description="正在验证账号权限…" />;
  if (!enabled || !auth.user) return <Redirect href="/settings/account" />;
  return <AuthorizedLabs key={`${auth.user.id}:${auth.user.features.join(',')}`} />;
}
