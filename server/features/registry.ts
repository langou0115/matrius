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
