import type { IconName } from '@/components/web/icon';
import { themePresets } from '@/theme/presets';

export const displayModes = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
] as const;

export const settingsItems = [
  { id: 'appearance', title: '外观', description: '调整显示模式与配色主题。', icon: 'sparkle', group: '偏好', keywords: `显示 浅色 深色 暗色 夜间 跟随系统 亮度 颜色 皮肤 light dark system theme ${themePresets.map((item) => `${item.id} ${item.name}`).join(' ')}` },
  { id: 'models', title: '模型服务', description: '添加服务商、API key 与模型，开始对话。', icon: 'bolt', group: '偏好', keywords: '模型 服务商 接入 密钥 地址 协议 base url api key openai anthropic responses' },
  { id: 'about', title: '关于 Matrius', description: '查看应用版本、运行模式与本地数据说明。', icon: 'info', group: '应用', keywords: '版本 本地 存储 数据 浏览器 隐私 about version' },
] as const satisfies readonly { id: string; title: string; description: string; icon: IconName; group: string; keywords: string }[];

export function searchSettings(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return settingsItems.filter((item) => {
    const text = `${item.title} ${item.description} ${item.group} ${item.keywords}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
