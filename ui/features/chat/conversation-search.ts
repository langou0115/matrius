import type { Message } from '@/core/agent/types';
import type { Conversation } from './chat-state';

export type ConversationSearchResult = {
  id: string;
  title: string;
  updatedAt: number;
  snippet: string | null;
};

export type HighlightPart = { text: string; match: boolean };

const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 110;
const plainTextCache = new WeakMap<Message, string>();

/**
 * Search snippets are read, not rendered. Strip the Markdown that would otherwise turn
 * a row into a wall of `**`, fences, and table pipes (LobeChat does the same for its
 * message results), while keeping inline code text and math source intact.
 */
export function toPlainText(content: string): string {
  return content
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*\*|___)(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, '$1$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainTextOf(message: Message): string {
  const cached = plainTextCache.get(message);
  if (cached !== undefined) return cached;
  const text = toPlainText(message.content);
  plainTextCache.set(message, text);
  return text;
}

/**
 * The newest message that contains the query. Scanning from the end keeps the snippet
 * tied to the latest context instead of surfacing the first time the words appeared.
 */
function newestText(conversation: Conversation, needle?: string): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const text = plainTextOf(conversation.messages[index]);
    if (!text) continue;
    if (!needle || text.toLocaleLowerCase().includes(needle)) return text;
  }
  return undefined;
}

/** One-line context around the match; whitespace is flattened so the row never grows. */
function snippetFor(content: string, needle: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  const index = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  if (index < 0) return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, Math.max(index + needle.length + 24, start + SNIPPET_LENGTH));
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Recent conversations for an empty box; title and message matches otherwise. Unlimited by
 * default; the dialog renders the list in pages as it scrolls. */
export function searchConversations(
  conversations: readonly Conversation[],
  query: string,
  limit = Infinity,
): ConversationSearchResult[] {
  if (limit <= 0) return [];
  const needle = query.trim().toLocaleLowerCase();
  const results: ConversationSearchResult[] = [];
  const sorted = [...conversations].sort((left, right) => right.updatedAt - left.updatedAt);

  for (const conversation of sorted) {
    const titleMatches = !!needle && conversation.title.toLocaleLowerCase().includes(needle);
    const matched = needle ? newestText(conversation, needle) : undefined;
    if (needle && !titleMatches && !matched) continue;
    // A title-only hit still gets a readable preview, without a highlight.
    const context = matched ?? newestText(conversation);
    results.push({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      snippet: context ? snippetFor(context, matched ? needle : '') : null,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Case-insensitive segments for the result title and snippet. */
export function splitMatches(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;
  let index = haystack.indexOf(target);
  while (index !== -1) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    const end = index + target.length;
    parts.push({ text: text.slice(index, end), match: true });
    cursor = end;
    index = haystack.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact recency label: 刚刚 / 3 分钟前 / 2 小时前 / 4 天前 / 10月28日. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return '刚刚';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} 天前`;
  const date = new Date(timestamp);
  const current = new Date(now);
  const monthAndDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === current.getFullYear()
    ? monthAndDay
    : `${date.getFullYear()}年${monthAndDay}`;
}
