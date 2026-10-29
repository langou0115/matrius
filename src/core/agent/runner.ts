import { Agent, type AgentTool, type StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import { directStream } from '@/core/llm/direct-stream';
import type { ThinkingEffort } from './thinking-effort';
import type { Message, MessageFile, ProcessActivity, ReplyUpdate, ReplyResult, SteerOutcome, WebActivity } from './types';
import { DEFAULT_SYSTEM_PROMPT, withCurrentContext } from './system-prompt';
import { buildContext, buildSteeringMessage } from './context';
import { collectGeneratedFiles, getFileActivityEnd, getFileActivityStart } from './file-tools';
import { getWebActivityEnd, getWebActivityStart } from './web-tools';

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

export function createReplyRun({ config, apiKey, messages, thinkingEffort = 'default', systemPrompt = withCurrentContext(DEFAULT_SYSTEM_PROMPT), tools = [], onUpdate, streamFn = directStream, timeoutMs = 120_000, maxDurationMs = 15 * 60_000 }: {
  config: ModelConfig; apiKey: string; messages: Message[];
  thinkingEffort?: ThinkingEffort;
  systemPrompt?: string;
  /** Registered cloud tools. Empty means a local text-only run, where a tool call is an error. */
  tools?: AgentTool[];
  onUpdate: (value: ReplyUpdate) => void; streamFn?: StreamFn;
  /** Maximum silence, reset by streamed output and tool progress. */
  timeoutMs?: number;
  maxDurationMs?: number;
}) {
  const model = createAgentModel(config);
  if (thinkingEffort !== 'default') model.reasoning = true;
  const agent = new Agent({
    initialState: { model, messages: buildContext(messages, config), systemPrompt, thinkingLevel: thinkingEffort === 'default' ? 'off' : thinkingEffort, tools },
    getApiKey: () => apiKey || 'no-key', streamFn,
    transport: 'sse', maxRetryDelayMs: 5000,
    // Match OpenStudio: serialize model tool calls, while each fetch batches four pages.
    // Parallel four-page calls otherwise overflow the account's four-request cap.
    toolExecution: 'sequential',
  });
  let stopped = false;
  let timedOut = false;
  let durationExceeded = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; agent.abort(); }, timeoutMs);
  }
  function timeoutError() {
    return durationExceeded ? '本轮生成时间过长，已保留收到的内容。'
      : '响应超时：服务商长时间未返回新内容。已生成内容已保留。';
  }
  let finalMessage: AssistantMessage | undefined;
  let unsupportedTool = false;
  let reasoningActive = false;
  // Run-wide latch: once the visible answer starts, later supplements wait for the next turn.
  // A new assistant message does not reopen steering; only a tool call clears it, because text
  // before a tool is usually a transition rather than the answer.
  let answerStarted = false;
  // A tool-using run produces several assistant messages. Keep the visible answer cumulative
  // instead of letting each new message erase the text that introduced its tool call.
  const contentTurns: string[] = [];
  const reasoningTurns: string[] = [];
  let activities: WebActivity[] = [];
  let process: ProcessActivity[] = [];
  let generatedFiles: MessageFile[] = [];
  let assistantIndex = 0;

  function setLast(target: string[], value: string) {
    if (target.length) target[target.length - 1] = value;
    else target.push(value);
  }
  function emit() {
    onUpdate({
      reasoningActive,
      content: contentTurns.filter(Boolean).join('\n\n'),
      reasoning: reasoningTurns.filter(Boolean).join('\n\n'),
      activities,
      process,
      ...(generatedFiles.length ? { files: generatedFiles } : {}),
    });
  }

  function startTool(event: { toolCallId: string; toolName: string; args: unknown }) {
    const activity = getWebActivityStart(event.toolName, event.toolCallId, event.args)
      ?? getFileActivityStart(event.toolName, event.toolCallId, event.args);
    if (!activity) return;
    const now = Date.now();
    const started = { ...activity, startedAt: now };
    activities = [...activities, started];
    process = [...process.map((item) => item.kind === 'thinking' && item.status === 'running'
      ? { ...item, status: 'complete' as const, endedAt: now } : item), started];
    emit();
  }

  function endTool(event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }) {
    const previous = activities.find((activity) => activity.id === event.toolCallId);
    const ended = getWebActivityEnd(event.toolName, event.toolCallId, event.result, event.isError, previous)
      ?? getFileActivityEnd(event.toolName, event.toolCallId, event.result, event.isError, previous);
    if (!event.isError) {
      for (const file of collectGeneratedFiles(event.result)) {
        if (!generatedFiles.some((item) => item.id === file.id)) generatedFiles = [...generatedFiles, file];
      }
    }
    const endedAt = Date.now();
    activities = activities.map((activity) => {
      if (activity.id !== event.toolCallId) return activity;
      if (!ended) return { ...activity, status: event.isError ? 'error' as const : 'complete' as const, endedAt };
      return { ...ended, startedAt: activity.startedAt, endedAt };
    });
    process = process.map((activity) => activity.id === event.toolCallId && activity.kind !== 'thinking'
      ? activities.find((item) => item.id === event.toolCallId)! : activity);
    emit();
  }

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'tool_execution_update'
      || (event.type === 'message_update' && event.message.role === 'assistant'
        && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.assistantMessageEvent.type))) resetIdleTimer();
    if (event.type === 'tool_execution_start') { startTool(event); return; }
    if (event.type === 'tool_execution_end') { endTool(event); return; }
    if (event.type === 'tool_execution_update') {
      const previous = activities.find((activity) => activity.id === event.toolCallId);
      const updated = getWebActivityEnd(event.toolName, event.toolCallId, event.partialResult, false, previous)
        ?? getFileActivityEnd(event.toolName, event.toolCallId, event.partialResult, false, previous);
      if (updated) {
        const next = { ...updated, status: 'running' as const, startedAt: previous?.startedAt };
        activities = activities.map((activity) => activity.id === event.toolCallId ? next : activity);
        process = process.map((activity) => activity.id === event.toolCallId && activity.kind !== 'thinking' ? next : activity);
        emit();
      }
      return;
    }
    if ((event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const message = event.message;
      if (event.type === 'message_start') {
        assistantIndex++;
        contentTurns.push('');
        reasoningTurns.push('');
      }
      if (event.type === 'message_update') {
        const type = event.assistantMessageEvent.type;
        if (type === 'thinking_start' || type === 'thinking_delta') reasoningActive = true;
        else if (type === 'thinking_end' || type === 'text_start' || type === 'text_delta') reasoningActive = false;
        if (type === 'text_start' || type === 'text_delta') answerStarted = true;
        else if (type === 'toolcall_start') answerStarted = false;
      } else if (event.type === 'message_end') {
        reasoningActive = false;
        // Text that introduced a tool call is not the final answer, so steering stays open
        // while the tool runs. A text-only turn is the answer.
        if (message.content.some((block) => block.type === 'toolCall')) answerStarted = false;
        else if (message.content.some((block) => block.type === 'text' && block.text.trim())) answerStarted = true;
      }
      message.content.forEach((block, index) => {
        if (block.type !== 'thinking') return;
        const id = `thinking:${assistantIndex}:${index}`;
        const previous = process.find((item) => item.kind === 'thinking' && item.id === id);
        const done = event.type === 'message_end' || (event.type === 'message_update'
          && event.assistantMessageEvent.type === 'thinking_end' && event.assistantMessageEvent.contentIndex === index);
        const next = { id, kind: 'thinking' as const, content: block.thinking,
          status: done || previous?.status === 'complete' ? 'complete' as const : 'running' as const,
          startedAt: previous?.startedAt ?? Date.now(),
          ...(done ? { endedAt: Date.now() } : previous?.endedAt !== undefined ? { endedAt: previous.endedAt } : {}),
        };
        process = previous ? process.map((item) => item.kind === 'thinking' && item.id === id ? next : item) : [...process, next];
      });
      setLast(contentTurns, message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
      setLast(reasoningTurns, message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''));
      emit();
      if (event.type === 'message_end') {
        finalMessage = message;
        // With tools registered, tool calls are the expected loop. Without them, the local
        // mode cannot execute anything, so surface the request as an error instead of hanging.
        if (!tools.length && message.content.some((block) => block.type === 'toolCall')) { unsupportedTool = true; agent.abort(); }
      }
    }
  });
  return {
    abort() { stopped = true; agent.abort(); },
    /** Queue a supplement for the current run. pi-agent injects it after the active turn. */
    steer(message: Message): SteerOutcome {
      if (message.role !== 'user' || stopped) return false;
      if (!message.content.trim() && !message.quote?.trim() && !message.images?.length
        && !message.fileIds?.length && !message.files?.length) return false;
      // Defer instead of merging into a reply whose visible text has already begun.
      if (answerStarted) return 'deferred';
      agent.steer(buildSteeringMessage(message));
      resetIdleTimer();
      return 'steered';
    },
    async start(): Promise<ReplyResult> {
      if (stopped) { unsubscribe(); return { status: 'stopped' }; }
      resetIdleTimer();
      const deadline = setTimeout(() => { timedOut = true; durationExceeded = true; agent.abort(); }, maxDurationMs);
      try {
        await agent.continue();
        // A steer can land while the loop is deciding to stop. Continue from the queued
        // message instead of dropping it or making the caller start a second run.
        while (!stopped && !timedOut && !unsupportedTool
          && finalMessage?.stopReason !== 'error' && finalMessage?.stopReason !== 'aborted'
          && agent.hasQueuedMessages()) {
          await agent.continue();
        }
        if (timedOut) return { status: 'error', error: timeoutError() };
        if (unsupportedTool) return { status: 'error', error: '当前本地模式仅支持文本对话，模型请求了不可用的工具。' };
        if (stopped || finalMessage?.stopReason === 'aborted') return { status: 'stopped' };
        if (finalMessage?.stopReason === 'error') return { status: 'error', error: describeModelError(finalMessage.errorMessage) };
        if (!finalMessage) return { status: 'error', error: agent.state.errorMessage ? describeModelError(agent.state.errorMessage) : '服务商未返回有效回复，请检查模型配置。' };
        if (!finalMessage.content.some((block) => block.type === 'text' && block.text.trim())) return { status: 'error', error: '服务商未返回回答正文，已保留思考和工具记录。' };
        if (finalMessage.stopReason === 'length') return { status: 'complete', error: '已达到最大输出长度，可继续追问。' };
        return { status: 'complete' };
      } catch (reason) {
        return stopped ? { status: 'stopped' } : { status: 'error', error: timedOut ? timeoutError() : describeModelError(reason) };
      } finally { clearTimeout(idleTimer); clearTimeout(deadline); unsubscribe(); }
    },
  };
}
