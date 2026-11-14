/** A single summary document, not a list of memory rows. It is rewritten as one text so the
    assistant's view of the user stays coherent instead of accumulating contradictory notes. */
export const MEMORY_SUMMARY_LIMIT = 4_000;

export type MemoryPreferences = {
  enabled: boolean;
  summary: string;
  /** Last summary change (not the enable toggle), in epoch milliseconds. */
  updatedAt: number | null;
};

export const defaultMemoryPreferences: MemoryPreferences = { enabled: true, summary: '', updatedAt: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMemoryPreferences(value: unknown): MemoryPreferences {
  if (value === undefined) return { ...defaultMemoryPreferences };
  if (!isRecord(value)) throw new Error('Invalid memory preferences');
  const enabled = value.enabled ?? true;
  const summary = value.summary ?? '';
  const updatedAt = value.updatedAt ?? null;
  if (typeof enabled !== 'boolean' || typeof summary !== 'string' || summary.length > MEMORY_SUMMARY_LIMIT
    || (updatedAt !== null && (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)))) {
    throw new Error('Invalid memory preferences');
  }
  return { enabled, summary, updatedAt };
}

/** The cloud field stores JSON in a generic profile field, so a stale or hand-edited value must
    degrade to an empty memory rather than breaking the workspace load. */
export function parseMemoryField(value: string | null | undefined): MemoryPreferences {
  if (!value) return { ...defaultMemoryPreferences };
  try {
    return readMemoryPreferences(JSON.parse(value));
  } catch {
    return { ...defaultMemoryPreferences };
  }
}

export function serializeMemoryField(memory: MemoryPreferences): string {
  const normalized = readMemoryPreferences(memory);
  return JSON.stringify({ enabled: normalized.enabled, summary: normalized.summary, updatedAt: normalized.updatedAt });
}

/** Prompts and tool results may wrap the summary in a fence; the stored value stays plain Markdown. */
export function normalizeMemorySummary(value: string): string {
  let text = value.trim();
  const tagged = /^<\s*memory\s*>([\s\S]*?)<\s*\/\s*memory\s*>$/i.exec(text);
  if (tagged) text = tagged[1].trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

const MEMORY_TAG = /<\/?(?:user_memory|user_instructions|user_profile|current_context|current_memory|latest_exchange|memory)>/gi;

/** Memory is model-written text. Encode wrapper tags so a summary cannot break the prompt. */
function sanitizeMemoryTags(value: string): string {
  return value.replace(MEMORY_TAG, (tag) => tag.replace('<', '&lt;').replace('>', '&gt;'));
}

/** A memory is background context, never a higher-priority instruction. */
export function memoryPromptBlock(memory: MemoryPreferences): string {
  if (!memory.enabled || !memory.summary.trim()) return '';
  return [
    '<user_memory>',
    '以下是记忆助手从过去的对话中整理的长期记忆。它可能已经过时；与用户当前的说法冲突时，以当前对话为准。',
    sanitizeMemoryTags(memory.summary.trim()),
    '</user_memory>',
  ].join('\n');
}
