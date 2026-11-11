export const thinkingEffortValues = ['default', 'low', 'medium', 'high'] as const;

export type ThinkingEffort = typeof thinkingEffortValues[number];

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return thinkingEffortValues.includes(value as ThinkingEffort);
}
