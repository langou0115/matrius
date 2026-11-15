import { normalizeConversationTitle } from '../../contract/agent-title';
import type { ModelConfig } from '../../contract/agent-protocol';
import { createReplyRun } from './runner';

export { normalizeConversationTitle };

/** Title generation is a one-shot side request and never enters conversation history. */
export const TITLE_SYSTEM_PROMPT = [
  '你负责为一段对话生成简短标题。',
  '只输出标题本身：不要引号、前缀、解释、标点或 Markdown。',
  '使用与用户消息相同的语言，优先用 6–12 个汉字或 3–6 个英文单词概括主题，不要复述整个问题；中英混合标题控制在 24 个字符内，并保留具体主题，不要只写产品或公司名。',
].join('\n');

const MAX_CONTENT_CHARS = 4_000;
const MAX_QUOTE_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 20_000;

function buildTitleInput(content: string, quote?: string): string {
  const message = content.trim().slice(0, MAX_CONTENT_CHARS);
  const reference = quote?.trim().slice(0, MAX_QUOTE_CHARS);
  if (!reference) return message;
  return `用户引用的历史回复（仅作参考）：\n${reference}\n\n用户消息：\n${message}`;
}

export async function generateConversationTitle({
  config,
  apiKey,
  content,
  quote,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  config: ModelConfig;
  apiKey: string;
  content: string;
  quote?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const input = buildTitleInput(content, quote);
  if (!input || (config.requiresApiKey && !apiKey) || signal?.aborted) return null;

  let latest = '';
  try {
    const run = createReplyRun({
      config,
      apiKey,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ id: 'title-request', role: 'user', content: input }],
      onUpdate: (update) => { latest = update.content; },
      timeoutMs,
      maxDurationMs: Math.max(timeoutMs * 2, 30_000),
      ...(signal ? { signal } : {}),
    });
    const result = await run.start();
    if (result.status !== 'complete') return null;
    return normalizeConversationTitle(latest);
  } catch {
    // Titles are optional decoration: provider errors and timeouts keep the fallback.
    return null;
  }
}
