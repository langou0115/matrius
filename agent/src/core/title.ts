import type { StreamFn } from '@mariozechner/pi-agent-core';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import { directStream } from '@agent/core/direct-stream';
import { withCurrentContext } from './system-prompt';

/** A title is a one-shot side request: it never enters the Agent loop or conversation history. */
export const TITLE_SYSTEM_PROMPT = [
  '你负责为一段对话生成简短标题。',
  '只输出标题本身：不要引号、前缀、解释、标点或 Markdown。',
  '使用与用户消息相同的语言，优先用 6–12 个汉字或 3–6 个英文单词概括主题，不要复述整个问题。',
].join('\n');

const MAX_CONTENT_CHARS = 4000;
const MAX_QUOTE_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

export { normalizeConversationTitle } from './title-text';
import { normalizeConversationTitle } from './title-text';

function buildTitleInput(content: string, quote?: string): string {
  const message = content.trim().slice(0, MAX_CONTENT_CHARS);
  const reference = quote?.trim().slice(0, MAX_QUOTE_CHARS);
  if (!reference) return message;
  return `用户引用的历史回复（仅作参考）：\n${reference}\n\n用户消息：\n${message}`;
}

export async function generateConversationTitle({ config, apiKey, content, quote, signal, streamFn = directStream, timeoutMs = DEFAULT_TIMEOUT_MS }: {
  config: ModelConfig;
  apiKey: string;
  content: string;
  quote?: string;
  signal?: AbortSignal;
  /** Tests inject a fake transport; production uses the same direct provider stream as chat. */
  streamFn?: StreamFn;
  timeoutMs?: number;
}): Promise<string | null> {
  const input = buildTitleInput(content, quote);
  if (!input || (config.requiresApiKey && !apiKey) || signal?.aborted) return null;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const stream = await Promise.race([streamFn({ ...createAgentModel(config), reasoning: true }, {
      systemPrompt: withCurrentContext(TITLE_SYSTEM_PROMPT),
      messages: [{ role: 'user', content: input, timestamp: Date.now() }],
    }, { apiKey: apiKey || 'no-key', reasoning: 'low', maxTokens: Math.min(512, config.maxOutput), signal: controller.signal }), timeout]);
    if (!stream) return null;
    const final = await Promise.race([stream.result(), timeout]);
    if (!final || final.stopReason === 'error' || final.stopReason === 'aborted' || final.stopReason === 'toolUse') return null;
    const text = final.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return normalizeConversationTitle(text);
  } catch {
    // Titles are optional decoration: provider errors and timeouts keep the truncated fallback.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
