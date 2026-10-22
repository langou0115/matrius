import { themePresets } from '@/theme/presets';

export const displayModes = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
] as const;

export const settingsItems = [
  { id: 'account', title: '账号', description: '登录账号、修改密码与管理登录状态。', group: '账号', keywords: '账号 登录 登出 密码 account login password' },
  { id: 'sync', title: '数据同步', description: '选择登录后要同步到云端的内容。', group: '账号', authOnly: true, keywords: '同步 云端 设备 数据 sync cloud 对话 消息 记忆 文件 外观' },
  { id: 'appearance', title: '外观', description: '调整显示模式与配色主题。', group: '偏好', keywords: `显示 浅色 深色 暗色 夜间 跟随系统 亮度 颜色 皮肤 light dark system theme ${themePresets.map((item) => `${item.id} ${item.name}`).join(' ')}` },
  { id: 'personalization', title: '个性化', description: '自定义指令、称呼、个人信息与对话标题。', group: '偏好', keywords: '个性化 自定义 指令 提示词 回复 风格 偏好 称呼 职业 关于你 标题 命名 生成 personalization instructions prompt profile title' },
  { id: 'models', title: '模型服务', description: '添加服务商、API key 与模型，开始对话。', group: '偏好', keywords: '模型 服务商 接入 密钥 地址 协议 base url api key openai anthropic responses' },
  { id: 'labs', title: '实验功能', description: '提前体验当前账号已开放的新功能。', group: '应用', keywords: '实验 测试 新功能 labs preview', feature: 'labs' },
  { id: 'about', title: '关于 Matrius', description: '查看应用版本、运行模式与本地数据说明。', group: '应用', keywords: '版本 本地 存储 数据 浏览器 隐私 about version' },
] as const satisfies readonly { id: string; title: string; description: string; group: string; keywords: string; feature?: string; authOnly?: boolean }[];

export function visibleSettings(features: readonly string[], preview = false, authenticated = false) {
  return settingsItems.filter((item) => {
    if (preview && (item.id === 'account' || 'authOnly' in item || 'feature' in item)) return false;
    if ('authOnly' in item && item.authOnly && !authenticated) return false;
    return !('feature' in item) || features.includes(item.feature);
  });
}

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
  { id: 'personalization-instructions', title: '自定义指令', description: '设置模型的回复方式与偏好', category: 'personalization', sectionId: 'instructions-heading', keywords: '个性化 自定义 指令 系统 提示词 回复 风格 偏好 instructions prompt' },
  { id: 'personalization-profile', title: '关于你', description: '设置称呼、职业与个人信息', category: 'personalization', sectionId: 'profile-heading', keywords: '个性化 关于你 称呼 名字 昵称 职业 兴趣 背景 个人 资料 信息 profile' },
  { id: 'personalization-title-model', title: '对话标题生成模型', description: '选择 AI 生成会话标题时使用的模型', category: 'personalization', sectionId: 'title-model-heading', keywords: '个性化 标题 命名 生成 模型 对话 会话 跟随当前对话 title model' },
  { id: 'appearance-display', title: '显示模式', description: '选择浅色、深色或跟随系统', category: 'appearance', sectionId: 'display-heading', keywords: '显示 模式 外观 浅色 深色 暗色 夜间 跟随系统 系统 亮度 颜色 light dark system mode' },
  { id: 'appearance-theme', title: '配色主题', description: '选择界面的配色主题', category: 'appearance', sectionId: 'theme-heading', keywords: `配色 主题 皮肤 颜色 外观 theme color ${themePresets.map((item) => `${item.id} ${item.name}`).join(' ')}` },
  { id: 'models-provider', title: '服务商', description: '添加服务商、接口协议与 API key', category: 'models', sectionId: 'providers-heading', keywords: '服务商 添加 编辑 删除 连接 接口 协议 密钥 api key base url 地址 获取模型列表 手动添加' },
  { id: 'models-detail', title: '模型配置', description: '模型 ID、上下文窗口与最大输出', category: 'models', sectionId: 'providers-heading', keywords: '模型 模型id model id 上下文 窗口 context window 最大输出 max output token 显示名称 添加 删除' },
  { id: 'sync-categories', title: '同步内容', description: '选择哪些内容跟着账号走', category: 'sync', sectionId: 'sync-content-heading', keywords: '同步 云端 内容 聊天记录 已读 未读 个人设置 外观 图片 文件 sync cloud' },
  { id: 'about-version', title: '版本与运行模式', description: '应用版本、本地模式与数据说明', category: 'about', sectionId: 'about-heading', keywords: '关于 版本 运行模式 本地 模式 浏览器 存储 数据 隐私 清除 1.0.0 about version local' },
] as const satisfies readonly { id: string; title: string; description: string; category: string; sectionId: string; keywords: string }[];

export function searchSettingsContent(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return settingsTargets.filter((item) => {
    const text = `${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
