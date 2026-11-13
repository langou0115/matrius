import { fromDbUuid, toMs } from '../db/codecs';
import type {
  MemoryRow,
  PreferenceRow,
  ProfileFieldRow,
  ProfileRow,
} from '../db/repositories/workspace';

export function preferencesOut(row: PreferenceRow): Record<string, unknown> {
  return {
    themeId: row.theme_id,
    mode: row.mode,
    revision: row.revision,
  };
}

export function profileOut(row: ProfileRow): Record<string, unknown> {
  return {
    customInstructions: row.custom_instructions,
    aboutName: row.about_name,
    occupation: row.occupation,
    aboutMore: row.about_more,
    revision: row.revision,
  };
}

export function profileFieldOut(row: ProfileFieldRow): Record<string, unknown> {
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.client_updated_at_ms ?? toMs(row.updated_at),
    revision: row.revision,
  };
}

export function memoryOut(row: MemoryRow): Record<string, unknown> {
  return {
    id: fromDbUuid(row.id),
    clientId: row.client_id,
    scope: row.scope,
    type: row.type,
    status: row.status,
    content: row.content,
    source: row.source,
    revision: row.revision,
    createdAt: row.client_created_at_ms ?? toMs(row.created_at),
    updatedAt: row.client_updated_at_ms ?? toMs(row.updated_at),
  };
}
