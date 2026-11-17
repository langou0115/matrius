import { sanitizeMemoryTags } from '../../contract/agent-memory';
import type { ModelConfig } from '../../contract/agent-protocol';

export type TaskSuggestion = {
  title: string;
  prompt: string;
};

const SYSTEM_PROMPT = [
  '你是 Matrius 的定时任务推荐助手。',
  '根据用户的「偏好与长期记忆」（如果为空则随机推荐实用、多样化的日常/工作/学习定时任务），生成正好 4 个适合用户的定时任务候选。',
  '每个候选包含 title（简短标题，不超过 16 字）和 prompt（清晰描述任务内容和预期结果，方便用户直接在弹窗中微调并创建）。',
  '只输出 JSON 数组，并放在 <suggestions> 与 </suggestions> 标签之间，不要输出任何额外解释。',
  '格式示例：<suggestions>[{"title":"每日 AI 早报","prompt":"每天早上9点搜索并总结今天最值得关注的 3 个 AI 开源项目更新，并附原文链接"}]</suggestions>',
].join('\n');

function parseSuggestions(raw: string): TaskSuggestion[] | null {
  const match = /<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/iu.exec(raw);
  const candidate = (match ? match[1] : raw).trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return null;
    const items: TaskSuggestion[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const title = String((entry as { title?: unknown }).title ?? '').replace(/\s+/gu, ' ').trim();
      const prompt = String((entry as { prompt?: unknown }).prompt ?? '')
        .replace(/^帮我新建一个定时任务[：:]\s*/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!title || !prompt) continue;
      items.push({
        title: title.slice(0, 40),
        prompt,
      });
      if (items.length === 4) break;
    }
    return items.length ? items : null;
  } catch {
    return null;
  }
}

export async function generateTaskSuggestions({
  config,
  apiKey,
  memorySummary,
  customInstructions,
  aboutMore,
  signal,
}: {
  config: ModelConfig;
  apiKey: string;
  memorySummary: string;
  customInstructions?: string;
  aboutMore?: string;
  signal?: AbortSignal;
}): Promise<TaskSuggestion[] | null> {
  if (config.requiresApiKey && !apiKey) return null;
  const profileParts = [
    memorySummary.trim() ? `长期记忆：\n${sanitizeMemoryTags(memorySummary.trim())}` : '',
    customInstructions?.trim() ? `自定义指令：\n${sanitizeMemoryTags(customInstructions.trim())}` : '',
    aboutMore?.trim() ? `关于用户：\n${sanitizeMemoryTags(aboutMore.trim())}` : '',
  ].filter(Boolean);

  let latest = '';
  try {
    const { createReplyRun } = await import('./runner');
    const run = createReplyRun({
      config,
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{
        id: 'task-suggestions-request',
        role: 'user',
        content: profileParts.length
          ? `<user_profile>\n${profileParts.join('\n\n')}\n</user_profile>\n请结合以上偏好与记忆生成 4 个定时任务候选。`
          : '当前用户没有偏好或记忆记录，请随机生成 4 个实用且多样化的定时任务候选。',
      }],
      thinkingEffort: 'low',
      onUpdate: (update) => { latest = update.content; },
      timeoutMs: 60_000,
      maxDurationMs: 120_000,
      ...(signal ? { signal } : {}),
    });
    const result = await run.start();
    if (result.status !== 'complete') return null;
    return parseSuggestions(latest);
  } catch {
    return null;
  }
}
