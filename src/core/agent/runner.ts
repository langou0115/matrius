import { Agent, type AgentMessage, type StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import type { Message } from '@/features/chat/chat-state';

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function buildContext(messages: Message[], config: ModelConfig): AgentMessage[] {
  const model = createAgentModel(config);
  return messages.filter((message) => message.content.trim()).map((message) => message.role === 'user'
    ? { role: 'user', content: message.content, timestamp: Date.now() }
    : { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: 'stop', timestamp: Date.now() });
}

const directStream: StreamFn = async (model, context, options) => {
  if (model.api === 'anthropic-messages') {
    const { streamSimpleAnthropic } = await import('@mariozechner/pi-ai/anthropic');
    return streamSimpleAnthropic({ ...model, api: 'anthropic-messages' }, context, options);
  }
  if (model.api === 'openai-responses') {
    const { streamSimpleOpenAIResponses } = await import('@mariozechner/pi-ai/openai-responses');
    return streamSimpleOpenAIResponses({ ...model, api: 'openai-responses' }, context, options);
  }
  const { streamSimpleOpenAICompletions } = await import('@mariozechner/pi-ai/openai-completions');
  return streamSimpleOpenAICompletions({ ...model, api: 'openai-completions' }, context, options);
};

function getErrorSignal(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 3 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (value instanceof Error) return `${value.name} ${value.message} ${getErrorSignal(value.cause, seen, depth + 1)}`;
  const record = value as Record<string, unknown>;
  return ['name', 'status', 'statusCode', 'code', 'type', 'message', 'error', 'detail', 'cause']
    .map((key) => getErrorSignal(record[key], seen, depth + 1))
    .filter(Boolean)
    .join(' ');
}

export function describeModelError(reason: unknown) {
  const text = getErrorSignal(reason);
  if (/insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|billing|payment required/i.test(text)) {
    return '服务商账户额度不足或未开通计费，请检查账户余额和套餐。';
  }
  if (/401|403|unauthori[sz]ed|authentication|invalid[_\s-]*api[_\s-]*key|api.?key.*(?:invalid|missing)/i.test(text)) {
    return '认证失败，请检查 API key、服务商权限和鉴权方式。';
  }
  if (/model[_\s-]*not[_\s-]*found|404|not found/i.test(text)) {
    return '服务商未找到该模型或接口，请检查模型 ID、协议和 Base URL。';
  }
  if (/context[_\s-]*length|context window|maximum context|too many tokens|token.*limit|input.*too long/i.test(text)) {
    return '对话超出模型上下文限制，请新建对话或调大模型设置中的上下文窗口。';
  }
  if (/429|rate[_\s-]*limit|too many requests|throttl/i.test(text)) {
    return '请求过于频繁，已触发服务商限流，请稍后重试。';
  }
  if (/413|payload too large|request[_\s-]*too[_\s-]*large/i.test(text)) {
    return '请求内容超出服务商限制，请缩短对话或减少输入内容后重试。';
  }
  if (/content[_\s-]*filter|safety[_\s-]*block|content policy/i.test(text)) {
    return '服务商安全策略拒绝了这条请求，请调整内容后重试。';
  }
  if (/timeout|timed out/i.test(text)) return '等待服务商响应超时，请检查网络或稍后重试。';
  if (/failed to fetch|networkerror|network error|fetch failed|connection|cors|econn|err_network/i.test(text)) {
    return '无法连接服务商，请检查网络和 Base URL，并确认服务商允许浏览器跨域请求（CORS）。';
  }
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway|server error/i.test(text)) {
    return '服务商暂时不可用，请稍后重试。';
  }
  if (/400|invalid[_\s-]*request|unsupported[_\s-]*(?:parameter|value)|bad request/i.test(text)) {
    return '服务商拒绝了请求，请检查模型协议、Base URL 和模型配置。';
  }
  return '模型回复失败，请检查模型配置和服务商状态后重试。';
}

export type ReplyUpdate = { content: string; reasoning: string };
export function createReplyRun({ config, apiKey, messages, onUpdate, streamFn = directStream, timeoutMs = 120_000 }: {
  config: ModelConfig; apiKey: string; messages: Message[];
  onUpdate: (value: ReplyUpdate) => void; streamFn?: StreamFn; timeoutMs?: number;
}) {
  const agent = new Agent({
    initialState: { model: createAgentModel(config), messages: buildContext(messages, config), systemPrompt: 'You are Matrius, a helpful assistant. Respond in the user’s language.', thinkingLevel: 'off', tools: [] },
    getApiKey: () => apiKey || 'no-key', streamFn,
    transport: 'sse', maxRetryDelayMs: 5000,
  });
  let stopped = false;
  let timedOut = false;
  let finalMessage: AssistantMessage | undefined;
  let unsupportedTool = false;
  const unsubscribe = agent.subscribe((event) => {
    if ((event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const message = event.message;
      onUpdate({ content: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), reasoning: message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('') });
      if (event.type === 'message_end') {
        finalMessage = message;
        if (message.content.some((block) => block.type === 'toolCall')) { unsupportedTool = true; agent.abort(); }
      }
    }
  });
  return {
    abort() { stopped = true; agent.abort(); },
    async start(): Promise<{ status: 'complete' | 'stopped' | 'error'; error?: string }> {
      if (stopped) { unsubscribe(); return { status: 'stopped' }; }
      const timeout = setTimeout(() => { timedOut = true; agent.abort(); }, timeoutMs);
      try {
        await agent.continue();
        if (timedOut) return { status: 'error', error: '请求超时，已停止生成。已收到的内容会保留。' };
        if (unsupportedTool) return { status: 'error', error: '当前本地模式仅支持文本对话，模型请求了不可用的工具。' };
        if (stopped || finalMessage?.stopReason === 'aborted') return { status: 'stopped' };
        if (finalMessage?.stopReason === 'error') return { status: 'error', error: describeModelError(finalMessage.errorMessage) };
        if (!finalMessage) return { status: 'error', error: agent.state.errorMessage ? describeModelError(agent.state.errorMessage) : '服务商未返回有效回复，请检查模型配置。' };
        if (finalMessage.stopReason === 'length') return { status: 'complete', error: '已达到最大输出长度，可继续追问。' };
        return { status: 'complete' };
      } catch (reason) {
        return stopped ? { status: 'stopped' } : { status: 'error', error: timedOut ? '模型请求超时，请稍后重试。' : describeModelError(reason) };
      } finally { clearTimeout(timeout); unsubscribe(); }
    },
  };
}
