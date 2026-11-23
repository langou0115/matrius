import { useEffect, useState, type FormEvent } from 'react';

import type { DesktopChatSettings } from '@contract/desktop-chat-settings';
import { ApiError } from '@/core/api/instance-client';
import { useInstance } from '@/features/instance/instance-state';

const path = '/api/desktop/chat-settings';

export function DesktopChatSettingsForm() {
  const { request } = useInstance();
  const [saved, setSaved] = useState<DesktopChatSettings>();
  const [storageLimit, setStorageLimit] = useState('');
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [reload, setReload] = useState(0);

  function apply(value: DesktopChatSettings) {
    setSaved(value);
    setStorageLimit(String(value.storageLimitBytes));
    setProxy(value.webtoolProxyUrl);
  }

  useEffect(() => {
    const controller = new AbortController();
    void request<DesktopChatSettings>(path, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) apply(value); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取设置失败。');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, reload]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || saving || stale) return;
    setSaving(true);
    setError('');
    setSavedNotice(false);
    try {
      apply(await request<DesktopChatSettings>(path, {
        method: 'PUT',
        body: JSON.stringify({
          storageLimitBytes: Number(storageLimit),
          webtoolProxyUrl: proxy.trim(),
          baseRevision: saved.revision,
        }),
      }));
      setSavedNotice(true);
    } catch (cause) {
      setStale(cause instanceof ApiError && cause.status === 409);
      setError(cause instanceof Error ? cause.message : '保存设置失败。');
    } finally {
      setSaving(false);
    }
  }

  const changed = saved && (storageLimit !== String(saved.storageLimitBytes) || proxy.trim() !== saved.webtoolProxyUrl);
  return <form className="personalization-fields" onSubmit={(event) => void save(event)} aria-busy={loading || saving}>
    <label className="personalization-field">
      <span>上传文件总量上限（字节）</span>
      <input className="text-field" type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required
        disabled={loading || saving || !saved} value={storageLimit} onChange={(event) => setStorageLimit(event.target.value)} />
    </label>
    <label className="personalization-field">
      <span>网页工具代理</span>
      <input className="text-field" type="url" maxLength={2048} autoComplete="off" placeholder="http://127.0.0.1:7890"
        disabled={loading || saving || !saved} value={proxy} onChange={(event) => setProxy(event.target.value)} />
      <small>留空时，网页搜索和网页读取直接连接。</small>
    </label>
    <div>
      <button className="secondary-button" type="submit" disabled={!changed || loading || saving || stale}>保存</button>
      {error && (!saved || stale) && <button className="secondary-button" type="button" onClick={() => {
        setSaved(undefined);
        setStale(false);
        setError('');
        setLoading(true);
        setReload((value) => value + 1);
      }}>重新加载</button>}
    </div>
    {savedNotice && !changed && <p className="settings-message is-success" role="status">设置已保存。</p>}
    {error && <p className="settings-message is-error" role="alert">{error}</p>}
  </form>;
}
