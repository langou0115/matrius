function normalizeMath(text: string): string {
  // Accept the LaTeX delimiters commonly emitted by model providers.
  text = text.replace(/(?<!\\)\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n\n$$\n${math.trim()}\n$$\n\n`)
    .replace(/(?<!\\)\\\(([^\n]*?)\\\)/g, (_, math: string) => `$${math}$`)
    .replace(/(?<!\\)\$\$([^\n$]+)\$\$/g, (_, math: string) => `\n\n$$\n${math.trim()}\n$$\n\n`);

  // Protect real math before escaping prices. Choose a marker absent from the
  // input, so arbitrary user text cannot collide with a placeholder.
  let marker = '\uE000MATH';
  while (text.includes(marker)) marker += '_';
  const formulas: string[] = [];
  text = text.replace(/(?<!\\)\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g, (match, formula?: string) => {
    const value = formula?.trim() ?? '';
    const isMath = formula === undefined || (/\\[a-zA-Z]+/.test(value)
      || (value.length > 0 && !/[\u3400-\u9fff]|\*\*|__|~~|[a-zA-Z]{3,}/.test(value)));
    if (!isMath) return match;
    return `${marker}${formulas.push(match) - 1}\uE001`;
  });
  text = text.replace(/(?<![\\$])\$(?!\$)(?=\s*[+-]?\d)/g, '\\$');
  formulas.forEach((formula, index) => { text = text.replace(`${marker}${index}\uE001`, () => formula); });
  return text;
}

/** Normalize math and currency only outside fenced code and inline code spans. */
export function normalizeMarkdown(content: string): string {
  let result = '';
  let plainStart = 0;
  let position = 0;
  while (position < content.length) {
    let codeEnd = -1;
    if (position === 0 || content[position - 1] === '\n') {
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(content.slice(position));
      if (fence) {
        const marker = fence[1];
        const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?=\\n|$)`, 'gm');
        closing.lastIndex = position + fence[0].length;
        const match = closing.exec(content);
        codeEnd = match ? match.index + match[0].length : content.length;
      }
    }
    if (codeEnd < 0 && content[position] === '`') {
      const run = /^`+/.exec(content.slice(position))![0];
      let end = content.indexOf(run, position + run.length);
      while (end >= 0 && (content[end - 1] === '`' || content[end + run.length] === '`')) end = content.indexOf(run, end + run.length);
      if (end >= 0) codeEnd = end + run.length;
      else { position += run.length; continue; }
    }
    if (codeEnd >= 0) {
      result += normalizeMath(content.slice(plainStart, position)) + content.slice(position, codeEnd);
      position = codeEnd;
      plainStart = position;
    } else position++;
  }
  return result + normalizeMath(content.slice(plainStart));
}
