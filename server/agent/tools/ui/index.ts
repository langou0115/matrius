import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static } from 'typebox';

import { AppError } from '../../../errors';
import type { ToolContext, ToolModule } from '../types';
import { uiComponentRuntimePrompt } from './prompt';
import { uiComponentParameters, uiComponentToolDescription } from './schema';

type Params = Static<typeof uiComponentParameters>;
type Details = Record<string, unknown>;

function describeToolError(reason: unknown): Error {
  if (reason instanceof AppError) return new Error(reason.message);
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return new Error('请求已取消。');
    const message = reason.message.replace(/\s+/gu, ' ').trim().slice(0, 600);
    if (message) return new Error(message);
  }
  return new Error('UI 工坊工具暂时不可用，请稍后重试。');
}

function required(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`缺少 ${field}。请先调用 list 获取真实 ID，不要编造。`);
  return text;
}

function text(value: string, details: Details) {
  return { content: [{ type: 'text' as const, text: value }], details };
}

function formatState(state: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(state ?? null, null, 2);
  } catch {
    serialized = String(state);
  }
  if (serialized.length > 6000) serialized = `${serialized.slice(0, 6000)}\n…(已截断)`;
  return serialized;
}

function createUiComponentTool(context: ToolContext): AgentTool<typeof uiComponentParameters, Details> {
  const scope = context.scope === 'workshop' ? 'workshop' : 'chat';
  const conversationId = context.conversationId;

  return {
    name: 'ui_component',
    label: 'UI component',
    description: uiComponentToolDescription,
    parameters: uiComponentParameters,
    execute: async (_toolCallId, params: Params) => {
      const ui = context.services?.ui;
      if (!ui) throw new Error('UI 工坊工具不可用。');
      try {
        switch (params.action) {
          case 'list': {
            const catalog = ui.catalogText();
            return text(
              catalog
                ? `Published components (use these exact ids):\n${catalog}\n\nIf one of them fits, render it with data from the user's message. Otherwise answer normally without a component.`
                : 'No published components are available. Answer normally; do not call render/open with an invented id.',
              { kind: 'ui_component', action: 'list' },
            );
          }
          case 'render': {
            const componentId = required(params.componentId, 'componentId');
            const resolved = ui.renderable(componentId, params.version);
            if (resolved.content.stateSchema) {
              throw new Error('这个组件是有状态的，请用 open 创建会话绑定，再用 command 操作；render 只用于展示型组件。');
            }
            const props = ui.validateProps(resolved.content, params.props);
            const artifact = {
              componentId: resolved.content.componentId,
              version: resolved.content.version,
              name: resolved.content.name,
              props,
            };
            return text(
              `Rendered 「${resolved.content.name}」 v${resolved.content.version} in the reply. Write one short sentence about what it shows and do not repeat the data as text.`,
              { kind: 'ui_component', action: 'render', artifact },
            );
          }
          case 'open': {
            const componentId = required(params.componentId, 'componentId');
            if (!conversationId) throw new Error('当前对话不可用，无法创建组件绑定。');
            const { snapshot } = ui.openBinding({
              conversationId,
              componentId,
              ...(params.version !== undefined ? { version: params.version } : {}),
              props: params.props,
            });
            const artifact = {
              componentId: snapshot.componentId,
              version: snapshot.version,
              name: snapshot.content.name,
              bindingId: snapshot.id,
            };
            return text(
              `Opened 「${snapshot.content.name}」 v${snapshot.version} for this conversation. bindingId: ${snapshot.id}. The component will report its initial state; use that state (or read_state) before sending a command. Do not repeat its data as text.`,
              { kind: 'ui_component', action: 'open', artifact },
            );
          }
          case 'command': {
            const bindingId = required(params.bindingId, 'bindingId');
            const commandName = required(params.commandName, 'commandName');
            if (!conversationId) throw new Error('当前对话不可用，无法发送组件命令。');
            ui.assertBindingInConversation(bindingId, conversationId);
            const result = ui.enqueueCommand({ bindingId, name: commandName, payload: params.payload });
            return text(
              `Queued command 「${commandName}」 for the component. It is applied asynchronously by the component itself; do not claim the new state before it reports back. If the command is illegal the component will report the reason.`,
              {
                kind: 'ui_component',
                action: 'command',
                artifact: result.artifact,
                command: result.command,
              },
            );
          }
          case 'read_state': {
            const bindingId = required(params.bindingId, 'bindingId');
            if (!conversationId) throw new Error('当前对话不可用，无法读取组件状态。');
            ui.assertBindingInConversation(bindingId, conversationId);
            const snapshot = ui.readState(bindingId);
            return text(
              `Current component state (revision ${snapshot.revision}):\n${formatState(snapshot.state)}`,
              { kind: 'ui_component', action: 'read_state', bindingId },
            );
          }
          case 'update': {
            if (scope !== 'workshop') throw new Error('只有 UI 工坊可以修改组件；普通对话只能渲染已发布的组件。');
            const componentId = required(context.uiComponentId ?? params.componentId, 'componentId');
            const html = required(params.html, 'html');
            const result = ui.saveVersion(componentId, {
              ...(params.name !== undefined ? { name: params.name } : {}),
              ...(params.description !== undefined ? { description: params.description } : {}),
              html,
              ...(params.inputSchema !== undefined ? { inputSchema: params.inputSchema } : {}),
              ...(params.stateSchema !== undefined ? { stateSchema: params.stateSchema } : {}),
              ...(params.commands !== undefined ? { commands: params.commands } : {}),
              ...(params.events !== undefined ? { events: params.events } : {}),
            });
            const stateful = Boolean(result.content.stateSchema);
            return text(
              `Saved 「${result.content.name}」 v${result.content.version} as a draft${stateful ? ' (stateful: stateSchema + commands declared)' : ''}. Tell the user in one short sentence what changed. Publishing is a separate action in the workshop; the preview updates automatically.`,
              { kind: 'ui_component', action: 'update', change: result.change },
            );
          }
          default:
            throw new Error('未知的 action。');
        }
      } catch (error) {
        throw describeToolError(error);
      }
    },
  };
}

export const uiComponentTool: ToolModule = {
  id: 'ui_component',
  feature: 'ui_workshop',
  dynamicPrompt: (context) => {
    const scope = context.scope === 'workshop' ? 'workshop' : 'chat';
    const ui = context.services?.ui;
    let catalog = '';
    let editing = '';
    try {
      catalog = scope === 'chat' ? (ui?.catalogText() ?? '') : '';
      if (scope === 'workshop' && context.uiComponentId) editing = ui?.editingContext(context.uiComponentId) ?? '';
    } catch {
      // A missing component or database error must not block the run prompt.
    }
    return uiComponentRuntimePrompt({ scope, catalog, editing });
  },
  create: (context) => createUiComponentTool(context),
};
