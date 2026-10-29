/** A deliberately small Markdown subset for the native client. The web keeps
    react-markdown; this parser only needs to cover what chat replies use often, and its
    output is shared by the native Text renderer and the formula WebView. */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'math'; tex: string; display: boolean };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'table'; code: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'rule' };

const fence = /^(```+|~~~+)\s*([^\s`]*)\s*$/;
const heading = /^(#{1,6})\s+(.*)$/;
const unordered = /^\s*[-*+]\s+(.*)$/;
const ordered = /^\s*(\d+)[.)]\s+(.*)$/;
const rule = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const tableSeparator = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isBlockStart(line: string) {
  return fence.test(line) || heading.test(line) || unordered.test(line) || ordered.test(line)
    || rule.test(line) || /^\s*>\s?/.test(line);
}

function parseInline(source: string): Inline[] {
  const nodes: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { nodes.push({ type: 'text', value: text }); text = ''; } };

  for (let index = 0; index < source.length;) {
    const char = source[index];

    if (char === '\\' && (source[index + 1] === '$' || source[index + 1] === '`')) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index) {
        flush();
        nodes.push({ type: 'code', value: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (char === '$' && source[index + 1] !== '$') {
      const end = source.indexOf('$', index + 1);
      if (end > index + 1) {
        const tex = source.slice(index + 1, end);
        if (!tex.startsWith(' ') && !tex.endsWith(' ') && !tex.includes('\n')) {
          flush();
          nodes.push({ type: 'math', tex, display: false });
          index = end + 1;
          continue;
        }
      }
    }

    if (char === '\\' && (source[index + 1] === '(' || source[index + 1] === '[')) {
      const closing = source[index + 1] === '(' ? '\\)' : '\\]';
      const end = source.indexOf(closing, index + 2);
      if (end > index) {
        flush();
        nodes.push({ type: 'math', tex: source.slice(index + 2, end), display: source[index + 1] === '[' });
        index = end + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const double = char.repeat(2);
      if (source.startsWith(double, index)) {
        const end = source.indexOf(double, index + 2);
        if (end > index + 2) {
          flush();
          nodes.push({ type: 'strong', children: parseInline(source.slice(index + 2, end)) });
          index = end + 2;
          continue;
        }
      }
      if (source[index + 1] !== char) {
        const end = source.indexOf(char, index + 1);
        if (end > index + 1 && !/\s/.test(source[index + 1]) && !/\s/.test(source[end - 1])) {
          flush();
          nodes.push({ type: 'em', children: parseInline(source.slice(index + 1, end)) });
          index = end + 1;
          continue;
        }
      }
    }

    if (char === '[') {
      const close = source.indexOf('](', index + 1);
      if (close > index) {
        const end = source.indexOf(')', close + 2);
        if (end > close) {
          const href = source.slice(close + 2, end).trim();
          if (/^(https?:|mailto:)/i.test(href)) {
            flush();
            nodes.push({ type: 'link', href, children: parseInline(source.slice(index + 1, close)) });
            index = end + 1;
            continue;
          }
        }
      }
    }

    text += char;
    index += 1;
  }
  flush();
  return nodes;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const open = fence.exec(line);
    if (open) {
      const marker = open[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang: open[2] ?? '', code: body.join('\n') });
      continue;
    }

    const head = heading.exec(line);
    if (head) {
      blocks.push({ type: 'heading', level: head[1].length, children: parseInline(head[2]) });
      index += 1;
      continue;
    }

    if (rule.test(line)) { blocks.push({ type: 'rule' }); index += 1; continue; }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }

    if (unordered.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const items: Inline[][] = [];
      while (index < lines.length) {
        const match = (isOrdered ? ordered : unordered).exec(lines[index]);
        if (!match) break;
        items.push(parseInline((isOrdered ? match[2] : match[1]).trim()));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && tableSeparator.test(lines[index + 1])) {
      const body: string[] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'table', code: body.join('\n') });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    // Defensive: a malformed construct must still consume its line.
    if (!paragraph.length) { paragraph.push(lines[index]); index += 1; }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

/** Inline `$...$` or `$$...$$` triggers the WebView; `$5 and $10` does not. */
export function containsMath(source: string): boolean {
  if (source.includes('\\(') || source.includes('\\[') || source.includes('$$')) return true;
  return /(^|[^\\$])\$(?![\s$])[^$\n]{1,400}?[^\s$]\$/m.test(source);
}

export function blockPlainText(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string => nodes.map((node) => node.type === 'text' ? node.value
    : node.type === 'code' ? node.value : node.type === 'math' ? node.tex : inline(node.children)).join('');
  const walk = (items: Block[]): string => items.map((block) => {
    switch (block.type) {
      case 'paragraph': return inline(block.children);
      case 'heading': return inline(block.children);
      case 'code': return block.code;
      case 'table': return block.code;
      case 'quote': return walk(block.blocks);
      case 'list': return block.items.map((item, i) => `${block.ordered ? `${i + 1}. ` : '• '}${inline(item)}`).join('\n');
      case 'rule': return '';
    }
  }).filter(Boolean).join('\n\n');
  return walk(blocks);
}
