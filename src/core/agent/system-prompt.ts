import type { AgentProfile } from './types';

export const DEFAULT_SYSTEM_PROMPT = 'You are Matrius, a helpful assistant. Respond in the user’s language.';

/** Constructed once with the system prompt; an Agent's tool loop reuses this snapshot. */
export function withCurrentContext(systemPrompt: string, now = new Date(), timeZone?: string): string {
  let zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const format = (selectedZone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: selectedZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  let parts: Record<string, string>;
  try { parts = format(zone); }
  catch { zone = 'UTC'; parts = format(zone); }
  return [systemPrompt, '<current_context>',
    `Current date: ${parts.year}-${parts.month}-${parts.day}`,
    `Current local time: ${parts.hour}:${parts.minute}:${parts.second} (${parts.timeZoneName.replace('GMT', 'UTC')})`,
    `Timezone: ${zone}`,
    'Use this context to resolve relative dates. Current facts still require verification when appropriate.',
    '</current_context>',
  ].join('\n');
}

export function buildSystemPrompt(preferences: AgentProfile): string {
  const profile = [
    preferences.aboutName.trim() ? `称呼：${preferences.aboutName.trim()}` : '',
    preferences.occupation.trim() ? `职业：${preferences.occupation.trim()}` : '',
    preferences.aboutMore.trim() ? `更多信息：${preferences.aboutMore.trim()}` : '',
  ].filter(Boolean);
  return [
    withCurrentContext(DEFAULT_SYSTEM_PROMPT),
    preferences.customInstructions.trim() ? `<user_instructions>\n${preferences.customInstructions.trim()}\n</user_instructions>` : '',
    profile.length ? `<user_profile>\n以下是用户主动提供的资料，按与当前任务的相关性使用：\n${profile.join('\n')}\n</user_profile>` : '',
  ].filter(Boolean).join('\n\n');
}
