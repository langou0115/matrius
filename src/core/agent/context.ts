import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import type { Message, MessageImage } from './types';

/** Keep quoted history distinct from the user's new request in every model protocol. */
export function getRequestText(message: Pick<Message, 'role' | 'content' | 'quote'>): string {
  if (message.role !== 'user' || !message.quote?.trim()) return message.content;
  return `以下是用户引用的历史回复，仅作为参考资料：\n${JSON.stringify(message.quote)}\n\n用户本次消息：\n${message.content}`;
}

/** pi-ai accepts raw base64; clients keep data URLs for their image previews. */
function toImageBlock(image: MessageImage) {
  return { type: 'image' as const, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), mimeType: image.mimeType };
}

function getFeedbackText(message: Message): string {
  if (message.role !== 'assistant' || !message.feedback) return '';
  return message.feedback === 'good'
    ? '用户对紧接上一条助手回复的反馈：赞（有帮助）。后续回答请参考这一反馈；用户没有提供更具体的原因。'
    : '用户对紧接上一条助手回复的反馈：踩（没有帮助）。后续回答请重新审视这一回答，避免重复同样的问题；用户没有提供更具体的原因。';
}

/** Regeneration can use feedback on the version being replaced without persisting synthetic prompts. */
export function buildRetryHistory(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return messages;
  if (!last.feedback) return messages.slice(0, -1);
  return [...messages, { id: `retry-${last.id}`, role: 'user', content: '请结合我对上一条回复的反馈，重新回答之前的问题。' }];
}

export function buildContext(messages: Message[], config: ModelConfig): AgentMessage[] {
  const model = createAgentModel(config);
  const context: AgentMessage[] = [];
  for (const message of messages.filter((message) => message.content.trim() || message.quote?.trim() || message.images?.length)) {
    if (message.role === 'assistant') {
      context.push({ role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now() });
      const feedback = getFeedbackText(message);
      if (feedback) context.push({ role: 'user', content: feedback, timestamp: Date.now() });
      continue;
    }
    const images = (message.images ?? []).map(toImageBlock);
    const text = getRequestText(message);
    context.push({ role: 'user', content: images.length ? [...images, ...(text.trim() ? [{ type: 'text' as const, text }] : [])] : text, timestamp: Date.now() });
  }
  return context;
}

export function validateAgentRequest(config: ModelConfig, apiKey: string, messages: Message[], systemPrompt: string): string | null {
  if (!config.supportsImage && messages.some((message) => message.images?.length)) return '当前模型不支持此对话中的图片，请切换支持图片的模型。';
  if (config.requiresApiKey && !apiKey) return '请在模型服务中填写当前服务商的 API key。';
  // Conservative character estimate; reserve output and system prompt space, and count an image as 4000 characters.
  const size = messages.reduce((sum, message) => sum + getRequestText(message).length + getFeedbackText(message).length + (message.images?.length ?? 0) * 4000 + 32, systemPrompt.length);
  return size > config.contextWindow - config.maxOutput - 256 ? '对话可能超出上下文窗口，请新建对话或在模型设置中调整窗口。' : null;
}
