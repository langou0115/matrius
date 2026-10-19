import type { StreamFn } from '@mariozechner/pi-agent-core';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import { directStream } from '@/core/llm/direct-stream';

/** A title is a one-shot side request: it never enters the Agent loop or conversation history. */
export const TITLE_SYSTEM_PROMPT = [
  '你负责为一段对话生成简短标题。',
  '只输出标题本身：不要引号、前缀、解释、标点或 Markdown。',
  '使用与用户消息相同的语言，控制在 20 个汉字或 8 个英文单词以内。',
].join('\n');

const MAX_TITLE_CHARS = 32;
const MAX_CONTENT_CHARS = 4000;
const MAX_QUOTE_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Keep a generated title to one clean line, even when a model ignores the instructions. */
export function normalizeConversationTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const text = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*•]|\d+[.)、])\s+/, '')
    .replace(/^(?:conversation\s+title|title|对话标题|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const characters = splitGraphemes(text);
  return (characters.slice(0, MAX_TITLE_CHARS).join('').trim() || null);
}

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((part) => part.segment);
  }
  return Array.from(value);
}

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
    const stream = await Promise.race([streamFn(createAgentModel(config), {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input, timestamp: Date.now() }],
    }, { apiKey: apiKey || 'no-key', maxTokens: Math.min(64, config.maxOutput), signal: controller.signal }), timeout]);
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
