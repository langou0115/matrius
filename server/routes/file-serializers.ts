import type { MessageFile } from '../../contract/agent-protocol';
import { fromDbUuid, toMs } from '../db/codecs';
import type { StoredFileRow } from '../db/repositories/conversations';

export function fileOut(row: StoredFileRow): Record<string, unknown> {
  return {
    id: fromDbUuid(row.id),
    clientId: row.client_id,
    conversationId: row.conversation_id ? fromDbUuid(row.conversation_id) : null,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sha256: row.sha256,
    status: row.status,
    revision: row.revision,
    createdAt: toMs(row.created_at),
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
