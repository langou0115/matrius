import { Link, type Href } from '@/router';
import { ChevronRight, LogIn, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { hasFeature } from '@/core/features/capabilities';
import { useAuth } from '@/features/auth/auth-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { getFileUsage, type StorageCategory, type StorageUsage } from './files-api';
import { formatBytes } from './types';

function CategoryRow({ href, label, category, unit }: {
  href: Href;
  label: string;
  category?: StorageCategory;
  unit: string;
}) {
  const meta = category ? `${formatBytes(category.bytes)} · ${category.count} ${unit}` : '—';
  return <Link href={href} className="storage-category-row">
    <span className="storage-category-copy">
      <strong>{label}</strong>
      <span>{meta}</span>
    </span>
    <ChevronRight size={17} strokeWidth={1.75} aria-hidden="true" />
  </Link>;
}

/** Storage is its own settings category so the Library stays purely about browsing files. */
export default function StorageScreen() {
  const auth = useAuth();
  const enabled = hasFeature(auth.status === 'authenticated' ? auth.user : null, 'files');
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getFileUsage(auth.request, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setUsage(value);
        setFailed(false);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [auth.request, enabled, reloadKey]);

  const ratio = usage && usage.quota > 0 ? Math.min(1, usage.used / usage.quota) : 0;
  const hasFiles = Boolean(usage && usage.used > 0);

  if (auth.status === 'checking') {
    return <SettingsPage title="存储" description="查看已用空间，管理已保存的文件与图片。">
      <p className="settings-footnote" role="status">正在验证账号…</p>
    </SettingsPage>;
  }

  if (!enabled) {
    const unavailable = auth.status === 'unavailable';
    return <SettingsPage title="存储" description="查看已用空间，管理已保存的文件与图片。">
      <section className="settings-section" aria-labelledby="storage-login-heading">
        <h2 id="storage-login-heading">{unavailable ? '暂时无法验证账号' : auth.user ? '存储尚未开放' : '登录后查看存储空间'}</h2>
        <p className="settings-footnote">{unavailable
          ? '无法连接账号服务，请稍后刷新页面重试。'
          : auth.user
            ? '当前账号还没有开通文件功能，请联系管理员。'
            : '登录后，对话中上传的图片和文档会保存在云端，可以在这里查看用量并管理。'}</p>
        {!auth.user && !unavailable && <Link href="/settings/account" className="primary-button storage-login-action">
          <LogIn size={16} strokeWidth={1.75} aria-hidden="true" />前往登录
        </Link>}
      </section>
    </SettingsPage>;
  }

  return <SettingsPage title="存储" description="查看已用空间，管理已保存的文件与图片。">
    <section className="settings-section" aria-labelledby="storage-heading">
      <h2 id="storage-heading">存储空间</h2>
      {usage ? <>
        <p className="storage-summary">已使用 <strong>{formatBytes(usage.used)}</strong>，共 {formatBytes(usage.quota)}</p>
        <div className="storage-meter-track" role="progressbar" aria-label="存储空间"
          aria-valuemin={0} aria-valuemax={usage.quota} aria-valuenow={usage.used}>
          {hasFiles && <span className="storage-meter-fill" style={{ width: `${ratio * 100}%` }} />}
        </div>
      </> : failed ? <div className="storage-retry" role="alert">
        <span>暂时无法获取存储空间。</span>
        <button type="button" className="secondary-button" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />重试
        </button>
      </div> : <p className="settings-footnote" role="status">正在获取存储空间…</p>}
    </section>

    <section className="settings-section" aria-labelledby="storage-manage-heading">
      <h2 id="storage-manage-heading">管理存储空间</h2>
      <p className="storage-section-caption">管理已存储的内容，释放空间</p>
      <div className="account-list storage-categories">
        <CategoryRow href={'/library?kind=file' as Href} label="文件" category={usage?.files} unit="个文件" />
        <CategoryRow href={'/library?kind=image' as Href} label="图像" category={usage?.images} unit="张图像" />
      </div>
    </section>
  </SettingsPage>;
}
