import { Link, type Href } from '@/router';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { hasFeature } from '@/core/features/capabilities';
import { useInstance } from '@/features/instance/instance-state';
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
  const instance = useInstance();
  const enabled = hasFeature(instance.status === 'ready' ? instance.info : null, 'files');
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getFileUsage(instance.request, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setUsage(value);
        setFailed(false);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [instance.request, enabled, reloadKey]);

  const ratio = usage && usage.disk.total > 0 ? Math.min(1, usage.disk.used / usage.disk.total) : 0;
  const hasFiles = Boolean(usage && usage.disk.used > 0);

  return <SettingsPage title="存储" description="查看部署服务器的磁盘容量与可用空间。">
    <section className="settings-section" aria-labelledby="storage-heading">
      <h2 id="storage-heading">服务器磁盘</h2>
      {usage ? <>
        <p className="storage-summary">已使用 <strong>{formatBytes(usage.disk.used)}</strong>，共 {formatBytes(usage.disk.total)}，可用 {formatBytes(usage.disk.free)}</p>
        <div className="storage-meter-track" role="progressbar" aria-label="存储空间"
          aria-valuemin={0} aria-valuemax={usage.disk.total} aria-valuenow={usage.disk.used}>
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
      <p className="storage-section-caption">管理本应用保存的内容，释放磁盘空间</p>
      <div className="settings-list storage-categories">
        <CategoryRow href={'/library?kind=file' as Href} label="文件" category={usage?.files} unit="个文件" />
        <CategoryRow href={'/library?kind=image' as Href} label="图像" category={usage?.images} unit="张图像" />
      </div>
    </section>
  </SettingsPage>;
}
