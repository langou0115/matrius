import { randomUUID } from 'node:crypto';

import { Check } from 'typebox/value';

import {
  UI_COMPONENT_MAX_DECLARATIONS,
  UI_COMPONENT_MAX_HTML_CHARS,
  UI_COMPONENT_MAX_PROPS_CHARS,
  UI_COMPONENT_MAX_SCHEMA_CHARS,
  UI_COMPONENT_MAX_STATE_CHARS,
  UI_COMPONENT_MAX_VERSIONS,
  UI_COMPONENT_PROTOCOL_VERSION,
  jsonSize,
  summarizeSchema,
  uiComponentCatalogText,
  type UiBindingSnapshot,
  type UiComponentChange,
  type UiComponentCommandDeclaration,
  type UiComponentDetail,
  type UiComponentEventDeclaration,
  type UiComponentStatus,
  type UiComponentSummary,
  type UiComponentVersionContent,
  type UiComponentVersionSummary,
} from '../../contract/ui-component';
import type { AppDatabase } from '../db/client';
import { fromDbBool, fromDbJson, fromDbUuid, toMs } from '../db/codecs';
import {
  archiveComponentRow,
  finishCommandRow,
  getBindingRow,
  getComponentRow,
  getVersionRow,
  insertBindingRow,
  insertCommandRow,
  insertComponentRow,
  insertVersionRow,
  isUiComponentId,
  listComponentRows,
  listPendingCommandRows,
  listPublishedComponentRows,
  listVersionRows,
  patchComponentRow,
  publishVersionRow,
  updateBindingState,
  versionDeclarations,
  type UiBindingRow,
  type UiCommandRow,
  type UiComponentRow,
  type UiComponentVersionRow,
} from '../db/repositories/ui-components';
import { insertConversation } from '../db/repositories/conversations';
import { conflict, invalid, notFound } from '../errors';
import { hasFeature } from '../features/registry';

export const UI_WORKSHOP_INSTANCE_ID = 1;
const KEEP_DRAFTS = 20;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2_000;
const DECLARATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function componentIdOrThrow(id: string | null | undefined): string {
  if (!id || !isUiComponentId(id)) throw invalid('组件 ID 不合法。');
  return id;
}

function bindingIdOrThrow(id: string | null | undefined): string {
  if (!id || !isUiComponentId(id)) throw invalid('组件绑定 ID 不合法。');
  return id;
}

function summary(row: UiComponentRow): UiComponentSummary {
  return {
    id: fromDbUuid(row.id),
    name: row.name,
    description: row.description,
    status: row.status as UiComponentStatus,
    currentVersion: row.current_version,
    publishedVersion: row.published_version,
    stateful: fromDbBool(row.stateful),
    conversationId: row.conversation_id ? fromDbUuid(row.conversation_id) : null,
    updatedAt: toMs(row.updated_at) ?? 0,
    revision: row.revision,
  };
}

export function versionContent(row: UiComponentVersionRow): UiComponentVersionContent {
  const { commands, events } = versionDeclarations(row);
  return {
    componentId: fromDbUuid(row.component_id),
    version: row.version,
    status: row.status === 'published' ? 'published' : 'draft',
    name: row.name,
    description: row.description,
    html: row.html,
    inputSchema: fromDbJson<Record<string, unknown>>(row.input_schema) ?? { type: 'object', properties: {} },
    stateSchema: fromDbJson<Record<string, unknown>>(row.state_schema) ?? null,
    commands,
    events,
    protocolVersion: row.protocol_version,
  };
}

function versionSummary(row: UiComponentVersionRow): UiComponentVersionSummary {
  return {
    version: row.version,
    status: row.status === 'published' ? 'published' : 'draft',
    name: row.name,
    createdAt: toMs(row.created_at) ?? 0,
  };
}

function commandOut(row: UiCommandRow) {
  return {
    id: fromDbUuid(row.id),
    name: row.name,
    payload: fromDbJson<unknown>(row.payload),
    status: row.status as 'pending' | 'applied' | 'failed',
    ...(row.error ? { error: row.error } : {}),
  };
}

function assertText(value: string | undefined, max: number, field: string): string {
  const text = (value ?? '').trim();
  if (text.length > max) throw invalid(`${field}不能超过 ${max} 个字符。`);
  return text;
}

function assertSchema(schema: unknown, field: string): Record<string, unknown> {
  if (schema === undefined || schema === null) return { type: 'object', properties: {} };
  if (typeof schema !== 'object' || Array.isArray(schema)) throw invalid(`${field} 必须是 JSON Schema 对象。`);
  const record = schema as Record<string, unknown>;
  if (jsonSize(record) > UI_COMPONENT_MAX_SCHEMA_CHARS) throw invalid(`${field} 太大。`);
  return record;
}

function assertDeclarations<T extends { name: string }>(values: unknown, field: string): T[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw invalid(`${field} 必须是数组。`);
  if (values.length > UI_COMPONENT_MAX_DECLARATIONS) throw invalid(`${field} 最多 ${UI_COMPONENT_MAX_DECLARATIONS} 项。`);
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw invalid(`${field}[${index}] 不合法。`);
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || !DECLARATION_NAME.test(record.name)) {
      throw invalid(`${field}[${index}].name 只能包含字母、数字、下划线和连字符。`);
    }
    if (seen.has(record.name)) throw invalid(`${field} 中的名称不能重复：${record.name}`);
    seen.add(record.name);
    return value as T;
  });
}

/**
 * Generated code is untrusted even though the CSP sandbox blocks network and
 * eval. Reject the obvious accidents early so the model can regenerate instead
 * of shipping a component that freezes the tab.
 */
function assertHtml(html: string): void {
  const text = html.trim();
  if (!text) throw invalid('组件代码不能为空。');
  if (text.length > UI_COMPONENT_MAX_HTML_CHARS) {
    throw invalid(`组件代码不能超过 ${UI_COMPONENT_MAX_HTML_CHARS} 个字符。`);
  }
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/iu.test(text) || /id\s*=\s*["']root["']/iu.test(text)) {
    throw invalid('只提交 HTML 片段：不要包含 doctype、html、head、body 或自己的 #root，宿主会提供根节点。');
  }
  if (/(while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;\s*\))/u.test(text)) {
    throw invalid('组件代码不能包含无限循环，请改写为有明确上限的循环。');
  }
  if (/\beval\s*\(|new\s+Function\s*\(/u.test(text)) {
    throw invalid('组件代码不能使用 eval 或 new Function，沙箱会拒绝执行。');
  }
  const external = /<(?:script|link|iframe|object|embed)[^>]+(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu.exec(text);
  if (external) throw invalid('组件不能加载外部资源，请把所有样式和脚本内联。');
}

function assertJsonSize(value: unknown, max: number, field: string): void {
  if (jsonSize(value) > max) throw invalid(`${field} 超出体积上限。`);
}

function describeSchema(schema: Record<string, unknown>): string {
  const fields = summarizeSchema(schema);
  return fields ? `需要这些字段：${fields}` : '没有声明字段';
}

export type SaveVersionInput = {
  name?: string;
  description?: string;
  html: string;
  inputSchema?: unknown;
  stateSchema?: unknown;
  commands?: unknown;
  events?: unknown;
};

export type UiComponentService = ReturnType<typeof createUiComponentService>;

export function createUiComponentService(db: AppDatabase, instanceId = UI_WORKSHOP_INSTANCE_ID) {
  function requireFeature(): void {
    if (!hasFeature('ui_workshop')) invalid('当前实例尚未开放 UI 工坊。');
  }

  function getComponent(id: string): UiComponentRow {
    const row = getComponentRow(db, instanceId, componentIdOrThrow(id));
    if (!row) throw notFound('组件不存在。');
    return row;
  }

  function getVersion(componentId: string, version: number): UiComponentVersionRow {
    const row = getVersionRow(db, componentId, version);
    if (!row) throw notFound('组件版本不存在。');
    return row;
  }

  function getBinding(id: string): UiBindingRow {
    const row = getBindingRow(db, instanceId, bindingIdOrThrow(id));
    if (!row) throw notFound('组件绑定不存在。');
    return row;
  }

  function bindingSnapshot(id: string): UiBindingSnapshot {
    const binding = getBinding(id);
    const version = getVersion(binding.component_id, binding.version);
    return {
      id: fromDbUuid(binding.id),
      conversationId: fromDbUuid(binding.conversation_id),
      componentId: fromDbUuid(binding.component_id),
      version: binding.version,
      props: fromDbJson<unknown>(binding.props),
      state: fromDbJson<unknown>(binding.state),
      revision: binding.revision,
      pendingCommands: listPendingCommandRows(db, binding.id).map(commandOut),
      content: versionContent(version),
    };
  }

  function renderable(id: string, version?: number): {
    component: UiComponentRow;
    version: UiComponentVersionRow;
    content: UiComponentVersionContent;
  } {
    requireFeature();
    const component = getComponent(id);
    if (component.status === 'archived') throw invalid('组件已归档，无法在对话中渲染。');
    if (component.published_version === null) throw invalid('组件还没有发布，请先在 UI 工坊中发布。');
    const target = version ?? component.published_version;
    if (target > component.published_version) throw invalid('该版本尚未发布。');
    const row = getVersion(component.id, target);
    if (row.status !== 'published') throw invalid('该版本尚未发布。');
    return { component, version: row, content: versionContent(row) };
  }

  function validateProps(content: UiComponentVersionContent, props: unknown): unknown {
    const value = props === undefined ? {} : props;
    assertJsonSize(value, UI_COMPONENT_MAX_PROPS_CHARS, '组件数据');
    if (!Check(content.inputSchema as never, value)) {
      throw invalid(`组件「${content.name}」的数据不符合它的输入 Schema，${describeSchema(content.inputSchema)}。`);
    }
    return value;
  }

  function saveBindingState(id: string, state: unknown, baseRevision: number): { revision: number } {
    const binding = getBinding(id);
    const schema = fromDbJson<Record<string, unknown>>(binding.state_schema);
    if (!schema) throw invalid('该绑定没有状态 Schema，无法写入状态。');
    assertJsonSize(state, UI_COMPONENT_MAX_STATE_CHARS, '组件状态');
    if (!Check(schema as never, state)) throw invalid('组件状态不符合它声明的 stateSchema，已拒绝写入。');
    const row = updateBindingState(db, instanceId, binding.id, state, baseRevision);
    return { revision: row.revision };
  }

  return {
    hasPublished(): boolean {
      return listPublishedComponentRows(db, instanceId).length > 0;
    },

    list(options: { query?: string } = {}): UiComponentSummary[] {
      return listComponentRows(db, instanceId, options).map(summary);
    },

    detail(id: string): UiComponentDetail {
      const row = getComponent(id);
      return {
        component: summary(row),
        versions: listVersionRows(db, row.id).map(versionSummary),
      };
    },

    versionContent(id: string, version: number): UiComponentVersionContent {
      const row = getComponent(id);
      return versionContent(getVersion(row.id, version));
    },

    /** Latest version content; the workshop preview uses the newest draft. */
    latestContent(id: string): UiComponentVersionContent {
      const row = getComponent(id);
      const versions = listVersionRows(db, row.id);
      if (!versions.length) throw notFound('组件还没有任何版本。');
      return versionContent(versions[0]);
    },

    create(input: { name?: string; description?: string; stateful?: boolean }): { component: UiComponentSummary; conversationId: string } {
      requireFeature();
      const name = assertText(input.name, NAME_MAX, '组件名称') || '未命名组件';
      const description = assertText(input.description, DESCRIPTION_MAX, '组件描述');
      const conversationId = randomUUID();
      const component = db.transaction(() => {
        insertConversation(db, instanceId, {
          id: conversationId,
          title: name,
          pinned: false,
          kind: 'workshop',
          titleSource: 'manual',
        });
        return insertComponentRow(db, instanceId, {
          name,
          description,
          conversationId,
          stateful: input.stateful === true,
        });
      });
      return { component: summary(component), conversationId };
    },

    patch(id: string, input: { name?: string; description?: string }, baseRevision: number): UiComponentSummary {
      return db.transaction(() => {
        const row = getComponent(id);
        if (row.revision !== baseRevision) throw conflict('组件已在别处更新，请刷新后重试。', summary(row));
        const patch: { name?: string; description?: string } = {};
        if (input.name !== undefined) {
          const name = assertText(input.name, NAME_MAX, '组件名称');
          if (!name) throw invalid('组件名称不能为空。');
          patch.name = name;
        }
        if (input.description !== undefined) patch.description = assertText(input.description, DESCRIPTION_MAX, '组件描述');
        return summary(patchComponentRow(db, instanceId, row.id, patch));
      });
    },

    archive(id: string, baseRevision: number): void {
      db.transaction(() => {
        const row = getComponent(id);
        if (row.revision !== baseRevision) throw conflict('组件已在别处更新，请刷新后重试。', summary(row));
        archiveComponentRow(db, instanceId, row.id);
      });
    },

    publish(id: string, version: number, baseRevision: number): { component: UiComponentSummary; version: UiComponentVersionContent } {
      return db.transaction(() => {
        const row = getComponent(id);
        if (row.revision !== baseRevision) throw conflict('组件已在别处更新，请刷新后重试。', summary(row));
        const result = publishVersionRow(db, instanceId, row.id, version);
        return { component: summary(result.component), version: versionContent(result.version) };
      });
    },

    /** `update` from the workshop: always writes a new immutable draft version. */
    saveVersion(id: string, input: SaveVersionInput): {
      component: UiComponentSummary;
      content: UiComponentVersionContent;
      change: UiComponentChange;
    } {
      requireFeature();
      const component = getComponent(id);
      assertHtml(input.html);
      const name = assertText(input.name, NAME_MAX, '组件名称') || component.name;
      const description = input.description === undefined
        ? component.description
        : assertText(input.description, DESCRIPTION_MAX, '组件描述');
      const inputSchema = assertSchema(input.inputSchema, 'inputSchema');
      const stateSchema = input.stateSchema === undefined || input.stateSchema === null
        ? null
        : assertSchema(input.stateSchema, 'stateSchema');
      if (component.stateful && !stateSchema) {
        throw invalid('这个组件创建时选择了「与对话绑定（有状态）」，请同时提供 stateSchema。');
      }
      if (!component.stateful && stateSchema) {
        throw invalid('这个组件创建时选择了「展示型（不绑定对话）」，请不要提供 stateSchema，数据用 props 传入。');
      }
      const commands = assertDeclarations<UiComponentCommandDeclaration>(input.commands, 'commands');
      const events = assertDeclarations<UiComponentEventDeclaration>(input.events, 'events');
      const result = db.transaction(() => insertVersionRow(db, instanceId, component.id, {
        name,
        description,
        html: input.html,
        inputSchema,
        stateSchema,
        commands,
        events,
        protocolVersion: UI_COMPONENT_PROTOCOL_VERSION,
      }, { maxVersions: UI_COMPONENT_MAX_VERSIONS, keepDrafts: KEEP_DRAFTS }));
      return {
        component: summary(result.component),
        content: versionContent(result.version),
        change: {
          componentId: fromDbUuid(result.component.id),
          version: result.version.version,
          name,
          action: 'update',
        },
      };
    },

    /** Resolve a version the chat may render: published only, archived components excluded. */
    renderable(id: string, version?: number): {
      component: UiComponentRow;
      version: UiComponentVersionRow;
      content: UiComponentVersionContent;
    } {
      return renderable(id, version);
    },

    validateProps,

    catalogText(): string {
      const entries: Parameters<typeof uiComponentCatalogText>[0] = [];
      for (const component of listPublishedComponentRows(db, instanceId)) {
        if (!component.published_version) continue;
        const row = getVersionRow(db, component.id, component.published_version);
        if (!row) continue;
        const content = versionContent(row);
        entries.push({
          componentId: fromDbUuid(component.id),
          name: content.name,
          description: content.description,
          version: content.version,
          inputSchema: content.inputSchema,
          stateful: Boolean(content.stateSchema),
        });
      }
      return uiComponentCatalogText(entries);
    },

    /** Prompt context for the workshop: what the model is editing right now. */
    editingContext(id: string): string {
      const component = getComponent(id);
      const versions = listVersionRows(db, component.id);
      const latest = versions[0];
      const lines = [
        `当前正在编辑的组件：${component.name}（componentId: ${fromDbUuid(component.id)}，状态：${component.status === 'published' ? '已发布' : component.status === 'archived' ? '已归档' : '草稿'}）。`,
      ];
      if (latest) {
        const content = versionContent(latest);
        lines.push(`最新版本：v${content.version}（${content.status === 'published' ? '已发布' : '草稿'}）。`);
        lines.push(component.stateful
          ? '设计模式：有状态（与对话绑定）。必须声明 stateSchema，并按需声明 commands、实现 onCommand；状态由每个对话单独保存。'
          : '设计模式：展示型（不绑定对话）。数据通过 props 传入，不要声明 stateSchema 或 commands。');
        const props = summarizeSchema(content.inputSchema);
        if (props) lines.push(`当前 inputSchema 字段：${props}。`);
        if (content.commands.length) lines.push(`已声明的命令：${content.commands.map((item) => item.name).join(', ')}。`);
      } else {
        lines.push('这个组件还没有任何版本，第一次 update 会创建 v1。');
      }
      lines.push('修改组件时调用 ui_component 的 update，并提交完整的 html；不要只提交补丁。');
      return lines.join('\n');
    },

    openBinding(input: {
      conversationId: string;
      componentId: string;
      version?: number;
      props: unknown;
    }): { snapshot: UiBindingSnapshot } {
      const resolved = renderable(input.componentId, input.version);
      if (!resolved.content.stateSchema) {
        throw invalid('这个组件没有声明 stateSchema，是展示型组件，请使用 render 并直接传数据。');
      }
      const props = validateProps(resolved.content, input.props);
      const binding = insertBindingRow(db, {
        instanceId,
        conversationId: input.conversationId,
        componentId: resolved.component.id,
        version: resolved.version.version,
        props,
        stateSchema: resolved.content.stateSchema,
      });
      return { snapshot: bindingSnapshot(fromDbUuid(binding.id)) };
    },

    bindingSnapshot,

    saveBindingState,

    enqueueCommand(input: { bindingId: string; name: string; payload: unknown }): {
      command: ReturnType<typeof commandOut>;
      artifact: {
        componentId: string;
        version: number;
        name: string;
        bindingId: string;
        commandIds: string[];
      };
      content: UiComponentVersionContent;
    } {
      const binding = getBinding(input.bindingId);
      const version = getVersion(binding.component_id, binding.version);
      const content = versionContent(version);
      if (!content.stateSchema) throw invalid('这个组件是无状态的，无法接收命令。');
      if (!content.commands.some((item) => item.name === input.name)) {
        throw invalid(`组件没有声明命令「${input.name}」，可用命令：${content.commands.map((item) => item.name).join(', ') || '无'}。`);
      }
      assertJsonSize(input.payload, UI_COMPONENT_MAX_PROPS_CHARS, '命令参数');
      const row = insertCommandRow(db, binding.id, input.name, input.payload);
      return {
        command: commandOut(row),
        artifact: {
          componentId: fromDbUuid(binding.component_id),
          version: binding.version,
          name: content.name,
          bindingId: fromDbUuid(binding.id),
          commandIds: [fromDbUuid(row.id)],
        },
        content,
      };
    },

    commandResult(id: string, commandId: string, result: {
      ok: boolean;
      error?: string;
      state?: unknown;
      baseRevision?: number;
    }): { revision?: number; status: 'applied' | 'failed' } {
      const binding = getBinding(id);
      let revision: number | undefined;
      if (result.state !== undefined) {
        if (result.baseRevision === undefined) throw invalid('写入组件状态需要 baseRevision。');
        try {
          revision = saveBindingState(fromDbUuid(binding.id), result.state, result.baseRevision).revision;
        } catch (error) {
          // A rejected state would otherwise keep the command pending and be re-delivered on
          // every reload. Record the failure and let the next turn start from the stored state.
          finishCommandRow(db, binding.id, commandId, {
            ok: false,
            error: error instanceof Error ? error.message : '写入组件状态失败。',
          });
          throw error;
        }
      }
      const command = finishCommandRow(db, binding.id, commandId, result);
      return {
        ...(revision !== undefined ? { revision } : {}),
        status: command.status === 'failed' ? 'failed' : 'applied',
      };
    },

    readState(id: string): {
      artifact: { componentId: string; version: number; name: string; bindingId: string };
      state: unknown;
      revision: number;
    } {
      const binding = getBinding(id);
      const version = getVersion(binding.component_id, binding.version);
      const content = versionContent(version);
      return {
        artifact: {
          componentId: fromDbUuid(binding.component_id),
          version: binding.version,
          name: content.name,
          bindingId: fromDbUuid(binding.id),
        },
        state: fromDbJson<unknown>(binding.state),
        revision: binding.revision,
      };
    },

    /** Used by the tool to prove a binding belongs to the active conversation. */
    assertBindingInConversation(bindingId: string, conversationId: string): void {
      const binding = getBinding(bindingId);
      if (fromDbUuid(binding.conversation_id) !== conversationId) {
        throw invalid('这个组件绑定属于其他对话。');
      }
    },
  };
}
