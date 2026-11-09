import { useInstance, useFeature } from '@/features/instance/instance-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { TokenUsageSection } from './token-usage-section';

export default function UsageScreen() {
  const instance = useInstance();
  const enabled = useFeature('usage');
  return <SettingsPage title="用量" description="查看实例的模型 Token 使用量与每日趋势。">
    {enabled ? <TokenUsageSection request={instance.request} enabled /> : <p className="settings-footnote" role="status">{instance.status === 'unavailable' ? '无法连接实例，请稍后重试。' : '正在获取实例资源…'}</p>}
  </SettingsPage>;
}
