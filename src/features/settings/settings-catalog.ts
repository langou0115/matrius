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

/** Individual settings inside a category, so search can reach the controls themselves rather
    than stopping at the category. `sectionId` matches the heading id on the target page. */
export const settingsTargets = [
  { id: 'appearance-display', title: '显示模式', description: '选择浅色、深色或跟随系统', category: 'appearance', sectionId: 'display-heading', keywords: '显示 模式 外观 浅色 深色 暗色 夜间 跟随系统 系统 亮度 颜色 light dark system mode' },
  { id: 'appearance-theme', title: '配色主题', description: '选择界面的配色主题', category: 'appearance', sectionId: 'theme-heading', keywords: `配色 主题 皮肤 颜色 外观 theme color ${themePresets.map((item) => `${item.id} ${item.name}`).join(' ')}` },
  { id: 'models-provider', title: '服务商', description: '添加服务商、接口协议与 API key', category: 'models', sectionId: 'providers-heading', keywords: '服务商 添加 编辑 删除 连接 接口 协议 密钥 api key base url 地址 获取模型列表 手动添加' },
  { id: 'models-detail', title: '模型配置', description: '模型 ID、上下文窗口与最大输出', category: 'models', sectionId: 'providers-heading', keywords: '模型 模型id model id 上下文 窗口 context window 最大输出 max output token 显示名称 添加 删除' },
  { id: 'about-version', title: '版本与运行模式', description: '应用版本、本地模式与数据说明', category: 'about', sectionId: 'about-heading', keywords: '关于 版本 运行模式 本地 模式 浏览器 存储 数据 隐私 清除 1.0.0 about version local' },
] as const satisfies readonly { id: string; title: string; description: string; category: string; sectionId: string; keywords: string }[];

export function searchSettingsContent(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return settingsTargets.filter((item) => {
    const text = `${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
