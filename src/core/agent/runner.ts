import { Agent, type AgentTool, type StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

import { createAgentModel, type ModelConfig } from '@/core/llm/model-config';
import { directStream } from '@/core/llm/direct-stream';
import type { ThinkingEffort } from './thinking-effort';
import { thinkingBudgetsFor } from './thinking-budget';
import type { Message, MessageFile, ProcessActivity, ReplyUpdate, ReplyResult, SteerOutcome, TokenUsage, WebActivity } from './types';
import { DEFAULT_SYSTEM_PROMPT, withCurrentContext } from './system-prompt';
import { buildContext, buildSteeringMessage } from './context';
import { collectGeneratedFiles, getFileActivityEnd, getFileActivityStart } from './file-tools';
import { getWebActivityEnd, getWebActivityStart } from './web-tools';
import { createReplyDiagnostics } from './diagnostics';

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

/** Providers occasionally omit counters; never let NaN reach the reported total. */
function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function createReplyRun({ config, apiKey, messages, thinkingEffort = 'default', systemPrompt = withCurrentContext(DEFAULT_SYSTEM_PROMPT), tools = [], onUpdate, streamFn = directStream, timeoutMs = 120_000, maxDurationMs = 15 * 60_000, signal }: {
  config: ModelConfig; apiKey: string; messages: Message[];
  thinkingEffort?: ThinkingEffort;
  systemPrompt?: string;
  /** Registered cloud tools. Empty means a local text-only run, where a tool call is an error. */
  tools?: AgentTool[];
  onUpdate: (value: ReplyUpdate) => void; streamFn?: StreamFn;
  /** Maximum silence, reset by streamed output and tool progress. */
  timeoutMs?: number;
  maxDurationMs?: number;
  /** Cancels auxiliary runs (memory, for example) that are not tracked by the chat runtime. */
  signal?: AbortSignal;
}) {
  const model = createAgentModel(config);
  const diagnostics = createReplyDiagnostics(config, thinkingEffort);
  if (thinkingEffort !== 'default') model.reasoning = true;
  const agent = new Agent({
    initialState: { model, messages: buildContext(messages, config), systemPrompt, thinkingLevel: thinkingEffort === 'default' ? 'off' : thinkingEffort, tools },
    getApiKey: () => apiKey || 'no-key', streamFn: diagnostics.stream(streamFn),
    transport: 'sse', maxRetryDelayMs: 5000,
    // Keep reasoning from eating the whole reply window; document writes need the tokens.
    thinkingBudgets: thinkingBudgetsFor(config.maxOutput),
    // Match OpenStudio: serialize model tool calls, while each fetch batches four pages.
    // Parallel four-page calls otherwise overflow the account's four-request cap.
    toolExecution: 'sequential',
  });
  // A truncated reply carries no text and no usable tool call, so retrying it with less
  // thinking and a smaller chunk is strictly better than surfacing the failure to the user.
  const MAX_OUTPUT_RETRIES = 2;
  let outputRetries = 0;
  // A tool-using run makes several model calls, and retries still cost tokens; report the sum.
  const tokenUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  function countUsage(usage: AssistantMessage['usage']) {
    tokenUsage.input += tokenCount(usage.input);
    tokenUsage.output += tokenCount(usage.output);
    tokenUsage.cacheRead += tokenCount(usage.cacheRead);
    tokenUsage.cacheWrite += tokenCount(usage.cacheWrite);
  }
  const hasUsage = () => tokenUsage.input + tokenUsage.output + tokenUsage.cacheRead + tokenUsage.cacheWrite > 0;
  /** Usage travels with the result so the caller can report it to the account. */
  const finish = (result: ReplyResult, outcome: string) => diagnostics.finish(
    hasUsage() ? { ...result, usage: { ...tokenUsage } } : result, outcome,
  );
  let stopped = false;
  let timedOut = false;
  let durationExceeded = false;
  const abortFromSignal = () => { stopped = true; agent.abort(); };
  if (signal?.aborted) stopped = true;
  else signal?.addEventListener('abort', abortFromSignal, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; agent.abort(); }, timeoutMs);
  }
  function timeoutError() {
    return durationExceeded ? '本轮生成时间过长，已保留收到的内容。'
      : '响应超时：服务商长时间未返回新内容。已生成内容已保留。';
  }

  function outputRetryDirective(attempt: number): string {
    return [
      '[系统提示] 上一轮回复在输出长度上限处被截断，没有产生正文或完整的工具调用，这次尝试已丢弃。',
      attempt === 1
        ? '请立刻继续原任务：不要重复分析，不要输出长篇思考，直接调用 file 工具，并把这一批缩小到 1 个块（PPT 1-2 页、Word 1 个小节、表格不超过 20 行，且最多 20 条命令）。'
        : '请把范围再缩小一半：只完成剩余内容的第一小块，直接调用 file 工具，不要写解释。',
      '如果已经开了草稿，先用 list 找回草稿再继续，不要重建整个文档。',
    ].join('\n');
  }

  /** Only a reply with no visible text is unusable; a truncated answer keeps what it wrote. */
  function shouldRetryTruncatedReply(): boolean {
    if (outputRetries >= MAX_OUTPUT_RETRIES) return false;
    if (finalMessage?.stopReason !== 'length') return false;
    return !finalMessage.content.some((block) => block.type === 'text' && block.text.trim());
  }

  function retryTruncatedReply() {
    outputRetries += 1;
    // Drop the truncated assistant message: it has no text and would make `continue()`
    // illegal while replaying a partial tool call to the next request.
    if (agent.state.messages.at(-1)?.role === 'assistant') agent.state.messages = agent.state.messages.slice(0, -1);
    const level = agent.state.thinkingLevel;
    agent.state.thinkingLevel = outputRetries > 1 ? 'off'
      : level === 'high' || level === 'xhigh' ? 'medium'
        : level === 'medium' ? 'low' : 'off';
    diagnostics.outputRetry(outputRetries, String(agent.state.thinkingLevel));
    agent.state.messages = [...agent.state.messages, {
      role: 'user', content: outputRetryDirective(outputRetries), timestamp: Date.now(),
    }];
  }
  let finalMessage: AssistantMessage | undefined;
  let unsupportedTool = false;
  let reasoningActive = false;
  // Run-wide latch: once the visible answer starts, later supplements wait for the next turn.
  // A new assistant message does not reopen steering; only a tool call clears it, because text
  // before a tool is usually a transition rather than the answer.
  let answerStarted = false;
  // A tool-using run produces several assistant messages. Text in a message that also calls a
  // tool is a transition ("let me check…"), not part of the answer: the next message overwrites
  // it instead of letting every preamble pile up in the final reply. Messages without a tool
  // call are answers, so a supplement that legitimately continues the reply stays cumulative.
  const contentTurns: { text: string; answer: boolean }[] = [];
  const reasoningTurns: string[] = [];
  let activities: WebActivity[] = [];
  let process: ProcessActivity[] = [];
  let generatedFiles: MessageFile[] = [];
  let assistantIndex = 0;

  function setLast(target: string[], value: string) {
    if (target.length) target[target.length - 1] = value;
    else target.push(value);
  }
  function setLastContent(value: string) {
    const last = contentTurns.at(-1);
    if (last) last.text = value;
    else contentTurns.push({ text: value, answer: false });
  }
  /** Answers stay joined; the newest transition text is only a draft until replaced. */
  function visibleContent(): string {
    const answers: string[] = [];
    let draft = '';
    for (const turn of contentTurns) {
      if (!turn.answer) {
        if (turn.text) draft = turn.text;
        continue;
      }
      if (turn.text) answers.push(turn.text);
      draft = '';
    }
    return [...answers, ...(draft ? [draft] : [])].join('\n\n');
  }
  function emit() {
    onUpdate({
      reasoningActive,
      content: visibleContent(),
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
    diagnostics.toolEnd(event.isError);
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
        contentTurns.push({ text: '', answer: false });
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
      setLastContent(message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
      setLast(reasoningTurns, message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''));
      if (event.type === 'message_end') {
        // A message that requested a tool is a transition; only a tool-free message is an answer.
        const lastContent = contentTurns.at(-1);
        if (lastContent) lastContent.answer = !message.content.some((block) => block.type === 'toolCall');
      }
      emit();
      if (event.type === 'message_end') {
        finalMessage = message;
        countUsage(message.usage);
        diagnostics.messageEnd(message);
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
      if (stopped) { unsubscribe(); return finish({ status: 'stopped' }, 'cancelled_before_start'); }
      resetIdleTimer();
      const deadline = setTimeout(() => { timedOut = true; durationExceeded = true; agent.abort(); }, maxDurationMs);
      try {
        await agent.continue();
        // A steer can land while the loop is deciding to stop. Continue from the queued
        // message instead of dropping it or making the caller start a second run. A reply
        // cut off before its body is treated the same way, with less thinking and a
        // smaller chunk, because the user would otherwise just see an error.
        while (!stopped && !timedOut && !unsupportedTool
          && finalMessage?.stopReason !== 'error' && finalMessage?.stopReason !== 'aborted'
          && (agent.hasQueuedMessages() || shouldRetryTruncatedReply())) {
          if (!agent.hasQueuedMessages()) retryTruncatedReply();
          await agent.continue();
        }
        if (timedOut) return finish({ status: 'error', error: timeoutError() }, durationExceeded ? 'duration_timeout' : 'idle_timeout');
        if (unsupportedTool) return finish({ status: 'error', error: '当前本地模式仅支持文本对话，模型请求了不可用的工具。' }, 'unsupported_tool');
        if (stopped || finalMessage?.stopReason === 'aborted') return finish({ status: 'stopped' }, 'aborted');
        if (finalMessage?.stopReason === 'error') return finish({ status: 'error', error: describeModelError(finalMessage.errorMessage) }, 'provider_error');
        if (!finalMessage) return finish({ status: 'error', error: agent.state.errorMessage ? describeModelError(agent.state.errorMessage) : '服务商未返回有效回复，请检查模型配置。' }, 'missing_message');
        const hasText = finalMessage.content.some((block) => block.type === 'text' && block.text.trim());
        if (finalMessage.stopReason === 'length') return finish(hasText
          ? { status: 'complete', error: '已达到最大输出长度，可继续追问。' }
          : { status: 'error', error: outputRetries
            ? `已达到最大输出长度，但尚未生成回答正文。已自动降低思考并拆分重试 ${outputRetries} 次仍未成功：请把模型设置里的「最大输出」调到 8192 以上，或把思考强度调到低/关闭后重试。`
            : '已达到最大输出长度，但尚未生成回答正文。请调大模型的最大输出或降低思考深度后重试。' }, 'output_limit');
        if (!hasText) return finish({ status: 'error', error: finalMessage.content.some((block) => block.type === 'thinking')
          ? '模型仅返回了思考内容，没有回答正文。已保留思考和工具记录。'
          : '模型本次回复没有回答正文。已保留之前收到的内容和工具记录。' }, 'no_final_text');
        return finish({ status: 'complete' }, 'complete');
      } catch (reason) {
        return finish(stopped ? { status: 'stopped' } : { status: 'error', error: timedOut ? timeoutError() : describeModelError(reason) },
          stopped ? 'aborted' : timedOut ? 'timeout' : 'exception');
      } finally { clearTimeout(idleTimer); clearTimeout(deadline); signal?.removeEventListener('abort', abortFromSignal); unsubscribe(); }
    },
  };
}
