import type { AgentProfile } from './types';

export const DEFAULT_SYSTEM_PROMPT = 'You are Matrius, a helpful assistant. Respond in the user’s language.';

export function buildSystemPrompt(preferences: AgentProfile): string {
  const profile = [
    preferences.aboutName.trim() ? `称呼：${preferences.aboutName.trim()}` : '',
    preferences.occupation.trim() ? `职业：${preferences.occupation.trim()}` : '',
    preferences.aboutMore.trim() ? `更多信息：${preferences.aboutMore.trim()}` : '',
  ].filter(Boolean);
  return [
    DEFAULT_SYSTEM_PROMPT,
    preferences.customInstructions.trim() ? `<user_instructions>\n${preferences.customInstructions.trim()}\n</user_instructions>` : '',
    profile.length ? `<user_profile>\n以下是用户主动提供的资料，按与当前任务的相关性使用：\n${profile.join('\n')}\n</user_profile>` : '',
  ].filter(Boolean).join('\n\n');
}
