import { Link } from '@/router';
import { LogIn, RefreshCw } from 'lucide-react';

import { hasFeature } from '@/core/features/capabilities';
import { useAuth } from '@/features/auth/auth-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { TokenUsageSection } from './token-usage-section';

const DESCRIPTION = '查看账号的模型 Token 使用量与每日趋势。';

/**
 * Token usage is cloud-only account data: the browser reports each finished reply to the API,
 * which aggregates it per account. Local mode never records or shows usage.
 */
export default function UsageScreen() {
  const auth = useAuth();
  const user = auth.user;
  const enabled = hasFeature(auth.status === 'authenticated' ? user : null, 'usage');

  if (auth.status === 'checking') {
    return <SettingsPage title="用量" description={DESCRIPTION}>
      <p className="settings-footnote" role="status">正在验证账号…</p>
    </SettingsPage>;
  }

  if (!enabled) {
    const unavailable = auth.status === 'unavailable';
    return <SettingsPage title="用量" description={DESCRIPTION}>
      <section className="settings-section" aria-labelledby="usage-login-heading">
        <h2 id="usage-login-heading">
          {unavailable ? '暂时无法验证账号' : user ? '用量尚未开放' : '登录后查看用量'}
        </h2>
        <p className="settings-footnote">{unavailable
          ? '无法连接账号服务，请稍后刷新页面重试。'
          : user
            ? user.mustChangePassword
              ? '完成首次改密后即可查看账号的 Token 用量。'
              : '当前账号还没有开通用量统计，请联系管理员。'
            : '用量属于账号的云端数据。登录后，每次回复消耗的 token 会按天记录在这里；本地模式不记录用量。'}</p>
        {!user && !unavailable && <Link href="/settings/account" className="primary-button storage-login-action">
          <LogIn size={16} strokeWidth={1.75} aria-hidden="true" />前往登录
        </Link>}
        {unavailable && <div className="storage-retry">
          <button className="secondary-button" type="button" onClick={() => void auth.refresh()}>
            <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />重新验证
          </button>
        </div>}
      </section>
    </SettingsPage>;
  }

  return <SettingsPage title="用量" description={DESCRIPTION}>
    <TokenUsageSection request={auth.request} enabled />
  </SettingsPage>;
}
