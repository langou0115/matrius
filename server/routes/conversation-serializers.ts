import type {
  ContextSummary,
  MessageFile,
  StoredProcessActivity,
  StoredWebActivity,
} from '../../contract/agent-protocol';
import { fromDbBool, fromDbJson, fromDbUuid, toMs } from '../db/codecs';
import type {
  ConversationRow,
  MessageRow,
  StoredFileRow,
} from '../db/repositories/conversations';
import { messageActivities, messageFileIds, messageProcess } from '../db/repositories/conversations';

export function readState(state: string, readAtMs: number | null): Record<string, unknown> {
  if (state === 'read') return { state: 'read', readAt: readAtMs };
  return { state };
}

export function conversationOut(row: ConversationRow): Record<string, unknown> {
  return {
    id: fromDbUuid(row.id),
    clientId: row.client_id,
    title: row.title,
    pinned: fromDbBool(row.pinned),
    modelId: row.model_id,
    titleSource: row.title_source,
    contextSummary: fromDbJson<ContextSummary>(row.context_summary),
    clientUpdatedAt: row.client_updated_at_ms,
    readState: {
      completed: readState(row.completed_state, row.completed_read_at_ms),
      error: readState(row.error_state, row.error_read_at_ms),
    },
    revision: row.revision,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

export function fileSummary(row: StoredFileRow): MessageFile {
  return {
    id: fromDbUuid(row.id),
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    revision: row.revision,
  };
}

export function messageOut(
  row: MessageRow,
  filesById: Map<string, StoredFileRow> | undefined,
): Record<string, unknown> {
  const fileIds = messageFileIds(row);
  const files: MessageFile[] = [];
  if (filesById) {
    for (const id of fileIds) {
      const stored = filesById.get(id);
      if (stored) files.push(fileSummary(stored));
    }
  }
  return {
    id: fromDbUuid(row.id),
    clientId: row.client_id,
    conversationId: fromDbUuid(row.conversation_id),
    position: row.position,
    role: row.role,
    content: row.content,
    steering: fromDbBool(row.steering),
    quote: row.quote,
    feedback: row.feedback,
    reasoning: row.reasoning,
    activities: messageActivities(row) as StoredWebActivity[] | null,
    process: messageProcess(row) as StoredProcessActivity[] | null,
    thinkingMs: row.thinking_ms,
    status: row.status,
    error: row.error,
    fileIds,
    files,
    revision: row.revision,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}
