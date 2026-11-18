const MAX_TITLE_WIDTH = 32;
const MAX_MIXED_TITLE_WIDTH = 33;
const MAX_LATIN_TITLE_CHARS = 32;

const WIDE_CHAR = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Emoji_Presentation}|[\u3000-\u303f\uff00-\uffef]/u;
const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
// Only treat Chinese particles as dangling connectors when preceded by space/ASCII, so words like "数学求和" stay intact.
const DANGLING_CONNECTOR = /(?:(?:\s|^)(?:and|or|with|for|of|to|in|on|vs|versus)|(?<=\s|[A-Za-z0-9])[与和及跟或的])$/iu;

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((part) => part.segment);
  }
  return Array.from(value);
}

function graphemeWidth(grapheme: string): number {
  return WIDE_CHAR.test(grapheme) ? 2 : 1;
}

function stripDanglingConnectors(value: string): string {
  let result = value.trim();
  while (DANGLING_CONNECTOR.test(result)) {
    const next = result.replace(DANGLING_CONNECTOR, '').trim();
    if (!next || next === result) break;
    result = next;
  }
  return result;
}

/** Keep a generated title to one clean line, even when a model ignores the instructions. */
export function normalizeConversationTitle(raw: string): string | null {
  const unwrapped = raw.trim().replace(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/u, '$1');
  const firstLine = unwrapped.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '';
  const text = firstLine
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^(?:[-*•|]|\d+[.)、])\s+/u, '')
    .replace(/^(?:conversation\s+title|title|对话标题|标题)\s*[:：]\s*/iu, '')
    .replace(/^\*\*(.+)\*\*$/u, '$1')
    .replace(/^__(.+)__$/u, '$1')
    .replace(/^`(.+)`$/u, '$1')
    .replace(/^["'“”‘’「」『』【】《》]+|["'“”‘’「」『』【】《》]+$/gu, '')
    .replace(/[。！？!?：:；;，,、]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return null;

  const cjk = CJK_SCRIPT.test(text);
  const latin = /[A-Za-z]/u.test(text);
  const limit = cjk ? (latin ? MAX_MIXED_TITLE_WIDTH : MAX_TITLE_WIDTH) : MAX_LATIN_TITLE_CHARS;
  const graphemes = splitGraphemes(text);

  let width = 0;
  let cutIndex = 0;
  for (; cutIndex < graphemes.length; cutIndex++) {
    const nextWidth = width + graphemeWidth(graphemes[cutIndex]);
    if (nextWidth > limit) break;
    width = nextWidth;
  }

  let title = graphemes.slice(0, cutIndex).join('').trim();
  if (cutIndex < graphemes.length) {
    const splitMidWord = cutIndex > 0 && !/\s/u.test(graphemes[cutIndex - 1]) && !/\s/u.test(graphemes[cutIndex]);
    const trimmed = splitMidWord && /\s/u.test(title) ? title.replace(/\s+\S*$/u, '').trim() : title;
    const candidate = stripDanglingConnectors(trimmed);
    const candidateWidth = splitGraphemes(candidate).reduce((sum, item) => sum + graphemeWidth(item), 0);
    const candidateKeepsTopic = !cjk || CJK_SCRIPT.test(candidate);
    const titleHadDanglingConnector = stripDanglingConnectors(title) !== title;
    // A word-boundary trim must not leave only the brand prefix behind; keeping a hard cut
    // is preferable to a title that says just "Claude Desktop", unless the cut itself ends
    // in a dangling connector such as "与".
    if (candidate && ((candidateKeepsTopic && candidateWidth >= Math.floor(limit * 0.6)) || titleHadDanglingConnector)) {
      title = candidate;
    }
  }
  return title || null;
}
