const MAX_TITLE_CHARS = 16;
/** Keep a generated title to one clean line, even when a model ignores the instructions. */
export function normalizeConversationTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const text = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*•]|\d+[.)、])\s+/, '')
    .replace(/^(?:conversation\s+title|title|对话标题|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const words = text.split(' ').slice(0, 6).join(' ');
  const limit = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(words) ? MAX_TITLE_CHARS : 32;
  const characters = splitGraphemes(words);
  let title = characters.slice(0, limit).join('').trim();
  if (characters.length > limit && words[title.length] !== ' ' && /\s/u.test(title)) title = title.replace(/\s+\S*$/, '');
  return title || null;
}

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((part) => part.segment);
  }
  return Array.from(value);
}
