import type { FeatureId } from './types';

export type Feature = {
  readonly id: FeatureId;
  readonly name: string;
  readonly description: string;
};

/**
 * Features available to the single instance.
 *
 * There is no account or preview allow-list: registering a feature makes it
 * visible to every client that can reach this deployment. Keep the list
 * intentional and add the corresponding route guard (`requireFeature`) and UI
 * gate (`useFeature`) in the same change.
 */
export const FEATURES: readonly Feature[] = [
  { id: 'files', name: '文件与资料库', description: '上传文档、让模型读取或生成 Office/PDF 文件。' },
  { id: 'usage', name: 'Token 用量', description: '查看实例的模型 token 使用量与每日趋势。' },
  { id: 'tasks', name: '定时任务', description: '按设定周期或指定时间自动创建或复用对话并执行提示词。' },
  { id: 'work-git', name: '工作区 Git', description: '查看工作项目的 Git 分支和变更并提交选中的文件。' },
  { id: 'desktop-chat-settings', name: '桌面对话设置', description: '配置上传总量上限和网页工具代理。' },
  { id: 'work-file-search', name: '工作区文件搜索', description: '搜索本机文件并在工作区标签页打开。' },
];

export function enabledFeatures(): Feature[] {
  return [...FEATURES];
}

export function featureIds(): FeatureId[] {
  return FEATURES.map((feature) => feature.id);
}

export function hasFeature(id: FeatureId): boolean {
  return FEATURES.some((feature) => feature.id === id);
}
