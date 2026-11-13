/**
 * Models write LaTeX in whatever shape they please: delimited with `$$`, delimited with `\[`, or
 * not delimited at all — a bare `\frac{1}{2}` dropped into a sentence. Left alone, every one of
 * those shapes ends the same way: markdown eats the backslashes on the way to the screen (`\,`
 * becomes `,`, `\\` becomes `\`) and the derivation arrives as a wall of source.
 *
 * The repair is a single left-to-right scan. Each position is classified once — fenced code,
 * inline code, an existing formula, or prose that happens to contain a formula — and rewritten as
 * it is passed. That ordering matters: an earlier attempt ran seven regexes in sequence over the
 * raw text, and each one changed the input the next was written against, so whether a given
 * message survived depended on which shapes happened to combine. A scan has no such coupling;
 * whatever it decides at a position is decided once, with everything to the left already final.
 *
 * The parser is not reimplemented here. Every stretch of text handed back as `$…$` or `$$…$$` goes
 * to remark-math and KaTeX exactly as a model-written formula would; this file only decides where
 * those delimiters belong.
 */

type CodeRegion = { kind: 'code' | 'prose'; start: number; end: number };

/** Scripts that never appear inside math mode, only in the prose a misplaced `$$` swallowed. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

/** Macros whose argument is prose rather than math — `\text{其中 } D` names a region in Chinese. */
const TEXT_MACROS = new Set(['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'operatorname', 'mbox', 'hbox']);

/**
 * Commands that mean math and nothing else. A backslash is a common character in ordinary text —
 * `C:\Users\name`, a regex in a sentence — so an undelimited run is only promoted when the command
 * that opens it is on this list. Promotion is a one-way door: once a run is wrapped it can only
 * come back as a KaTeX error, never as the text the author wrote.
 */
const MATH_COMMANDS = new Set([
  'begin', 'end', 'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'binom', 'dbinom', 'tbinom', 'genfrac',
  'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'iiiint', 'oint', 'oiint',
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'hom',
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh',
  'arcsin', 'arccos', 'arctan', 'operatorname', 'mathop', 'mathrel', 'mathbin', 'mathord', 'mathopen',
  'mathclose', 'mathpunct', 'mathinner', 'mathchoice', 'mathstrut', 'mathclap', 'mathllap', 'mathrlap',
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathfrak', 'mathbb', 'boldsymbol',
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt',
  'hat', 'check', 'tilde', 'acute', 'grave', 'dot', 'ddot', 'breve', 'bar', 'vec',
  'widehat', 'widetilde', 'overline', 'underline', 'overbrace', 'underbrace', 'overrightarrow',
  'overleftarrow', 'overset', 'underset', 'stackrel', 'boxed', 'fbox', 'phantom',
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  'biggl', 'biggr', 'Biggl', 'Biggr', 'langle', 'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor',
  'lvert', 'rvert', 'lVert', 'rVert', 'lbrace', 'rbrace', 'lbrack', 'rbrack', 'vert', 'Vert',
  'cdot', 'cdots', 'ldots', 'dots', 'vdots', 'ddots', 'times', 'div', 'pm', 'mp', 'ast', 'star',
  'circ', 'bullet', 'oplus', 'otimes', 'ominus', 'cup', 'cap', 'setminus', 'subset', 'supset',
  'subseteq', 'supseteq', 'in', 'notin', 'ni', 'propto', 'equiv', 'cong', 'approx', 'sim', 'simeq',
  'neq', 'ne', 'ge', 'le', 'geq', 'leq', 'gtrsim', 'lesssim', 'll', 'gg', 'prec', 'succ',
  'parallel', 'perp', 'mid', 'nmid', 'implies', 'impliedby', 'iff', 'land', 'lor', 'neg', 'lnot',
  'forall', 'exists', 'nexists', 'therefore', 'because', 'models', 'vdash', 'to', 'gets',
  'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow',
  'longrightarrow', 'longleftarrow', 'longleftrightarrow', 'mapsto', 'longmapsto', 'hookrightarrow',
  'hookleftarrow', 'uparrow', 'downarrow', 'updownarrow', 'nearrow', 'searrow', 'xrightarrow', 'xleftarrow',
  'emptyset', 'varnothing', 'infty', 'aleph', 'hbar', 'ell', 'wp', 'prime', 'angle', 'triangle',
  'square', 'diamond', 'bot', 'top', 'partial', 'nabla', 'quad', 'qquad', 'hspace', 'vspace',
  'limits', 'nolimits', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'substack',
  'cases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'array',
  'aligned', 'align', 'alignedat', 'gathered', 'gather', 'split', 'multline', 'equation',
  'nonumber', 'notag', 'tag', 'mod', 'bmod', 'pmod', 'textcolor', 'color', 'rule', 'kern', 'mkern',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi', 'rho', 'varrho', 'sigma',
  'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta',
  'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
]);

/**
 * Commands that are a whole formula on their own: `\implies` and `\alpha` carry their meaning in
 * the name and have no braces to give themselves away. Everything else on the whitelist needs an
 * argument before it is worth promoting — a bare `\text` with nothing after it is not a formula,
 * and wrapping it would only turn a word into a KaTeX error.
 */
const STANDALONE_MATH = new Set([
  'implies', 'impliedby', 'iff', 'therefore', 'because', 'cdots', 'ldots', 'dots', 'vdots', 'ddots',
  'infty', 'partial', 'nabla', 'pm', 'mp', 'times', 'div', 'cdot', 'le', 'ge', 'ne', 'neq',
  'approx', 'equiv', 'sim', 'simeq', 'propto', 'in', 'notin', 'subset', 'supset', 'subseteq',
  'supseteq', 'cup', 'cap', 'forall', 'exists', 'nexists', 'to', 'gets', 'rightarrow', 'leftarrow',
  'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'perp', 'parallel',
  'emptyset', 'varnothing', 'aleph', 'hbar', 'ell', 'wp', 'prime', 'angle', 'triangle', 'bot',
  'top', 'land', 'lor', 'neg', 'lnot', 'models', 'vdash', 'mid', 'nmid', 'ast', 'star', 'circ',
  'bullet', 'oplus', 'otimes', 'ominus', 'setminus', 'gtrsim', 'lesssim', 'll', 'gg', 'prec',
  'succ', 'cong', 'geq', 'leq', 'ni',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi', 'rho', 'varrho', 'sigma',
  'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta',
  'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
]);

/** Characters that keep a spaced-out run together: `\int_0^1 x^2 \, dx` is one formula. */
const CONTINUES_AFTER_SPACE = /[0-9\\_^{}()[\]+*/<>=|,.!:'"&;?-]/;
const MATH_SYMBOLS = /[0-9+\-*/<>=|,.'!:[\]()&;?]/;

/** `{…}` with nested braces and escaped characters counted, or null when it never closes. */
function skipGroup(text: string, at: number): number | null {
  if (text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i + 1; }
  }
  return null;
}

/** The index just past `\begin{env}…\end{env}`, or null when it never closes. */
function readEnvironment(text: string, at: number): number | null {
  const opening = /^\\begin\{([A-Za-z][A-Za-z0-9]*\*?)\}/.exec(text.slice(at));
  if (!opening) return null;
  const closing = `\\end{${opening[1]}}`;
  for (let i = at + opening[0].length; i < text.length; i += 1) {
    // A second `\begin` means the first one was never finished. Refusing to span it stops an
    // unfinished opener from borrowing the next block's `\end` and wrapping both as one formula.
    if (text.startsWith('\\begin{', i)) return null;
    if (text.startsWith(closing, i)) return i + closing.length;
  }
  return null;
}

/**
 * The end of an undelimited formula that starts at `at`, or null when what is there is not one.
 * A run stops at the first thing that cannot belong to a formula — Chinese punctuation, a word of
 * three letters or more, a newline — which is what keeps `\frac{1}{2} 和更多内容` from swallowing
 * the sentence it was pasted into.
 */
function readMathRun(text: string, at: number): number | null {
  const first = /^\\([a-zA-Z]+)/.exec(text.slice(at));
  if (!first || !MATH_COMMANDS.has(first[1])) return null;
  let i = at;
  let spaced = false;
  while (i < text.length) {
    const character = text[i];
    if (character === '\n') break;
    if (character === '\\') {
      if (text.startsWith('\\begin{', i)) {
        const end = readEnvironment(text, i);
        if (end === null) return null;
        i = end; spaced = false; continue;
      }
      const next = text[i + 1] ?? '';
      if (!/[a-zA-Z]/.test(next)) {
        // Spacing, escaped punctuation and the row separator carry their meaning in the name.
        if (next === '\\' || next === '$' || ',;!: '.includes(next)) { i += 2; spaced = false; continue; }
        break;
      }
      const command = /^\\([a-zA-Z]+)/.exec(text.slice(i))!;
      if (!MATH_COMMANDS.has(command[1])) break;
      i += command[0].length;
      if (text[i] === '*') i += 1;
      spaced = false;
      continue;
    }
    if (character === ' ' || character === '\t') {
      const rest = /^[ \t]*(\S)/.exec(text.slice(i));
      if (!rest) break;
      if (CONTINUES_AFTER_SPACE.test(rest[1]) && rest[1] !== '}') { i += 1; spaced = true; continue; }
      // A short word is an operand — `\, dx`, `\iint_D xy` — a long one is the sentence resuming.
      const word = /^[ \t]*([a-zA-Z]+)/.exec(text.slice(i));
      if (word && word[1].length <= 2) { i += 1; spaced = true; continue; }
      break;
    }
    if (/[a-zA-Z]/.test(character)) {
      const word = /^[a-zA-Z]+/.exec(text.slice(i))![0];
      if (spaced && word.length >= 3) break;
      i += word.length; spaced = false; continue;
    }
    if (character === '{') { const end = skipGroup(text, i); if (end === null) break; i = end; spaced = false; continue; }
    if (character === '^' || character === '_') {
      i += 1;
      if (text[i] === '{') { const end = skipGroup(text, i); if (end === null) break; i = end; }
      else if (i < text.length && text[i] !== '\n') i += 1;
      spaced = false; continue;
    }
    if (MATH_SYMBOLS.test(character)) { i += 1; spaced = false; continue; }
    break;
  }
  const run = text.slice(at, i).trimEnd();
  // A lone `\alpha` is more likely a word the author escaped than a formula. Promotion needs
  // structure — an argument, a script, an environment — or a command that is never prose.
  if (!/[{}^_]/.test(run) && !run.startsWith('\\begin{') && !STANDALONE_MATH.has(first[1])) return null;
  return at + run.length;
}

/** Drops `\text{…}` and friends, whose argument is allowed to be readable prose. */
function stripTextMacros(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const opening = /^\\([a-zA-Z]+)/.exec(body.slice(i));
    if (opening && TEXT_MACROS.has(opening[1])) {
      let end = i + opening[0].length;
      while (body[end] === ' ') end += 1;
      const group = skipGroup(body, end);
      if (group !== null) { i = group; continue; }
    }
    out += body[i];
    i += 1;
  }
  return out;
}

/**
 * Whether a `$` pair holds prose rather than a formula. A model that opens `$$` and closes it two
 * paragraphs later is not delimiting math, and handing that stretch to KaTeX buries the headings,
 * the bold and the Chinese inside it under one error. Dropping the delimiters lets all of it
 * render as what it actually is.
 */
function looksLikeProse(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  const math = stripTextMacros(trimmed);
  if (CJK.test(math)) return true;
  if (/\*\*|__|~~|`/.test(math)) return true;
  // Math mode has no blank line in it — TeX stops at one — so a pair spanning a blank line is not
  // delimiting a single formula whatever LaTeX it holds. Unlike the markdown heuristics below,
  // this holds regardless of what commands the body contains, which is what keeps a `$$` the model
  // opened and then wandered away from out of KaTeX's hands.
  if (/\n[ \t]*\n/.test(math)) return true;
  // Past this point the body is plausibly one formula, and the markdown heuristics must not be
  // allowed to veto it: a `- x + 1, & x < 1` row inside `cases` looks exactly like a list item.
  if (/\\[a-zA-Z]+/.test(math)) return false;
  if (/^[ \t]*(?:[-*+]|\d+\.)[ \t]/m.test(math)) return true;
  if (/^[ \t]*#{1,6}[ \t]/m.test(math)) return true;
  return !/[a-zA-Z0-9]/.test(math);
}

/**
 * A display formula has to open a block of its own — with no blank line in front, markdown folds
 * the `$$` back into the paragraph above it and the formula leaks as text. The padding is applied
 * only where it is missing, which is what makes a second pass over the output a no-op: a reply is
 * re-rendered on every streamed character, and a normalizer that kept adding blank lines would
 * grow the message a line per frame.
 */
function display(text: string, at: number, end: number, body: string): string {
  const before = text.slice(0, at);
  const after = text.slice(end);
  const lead = before === '' || /(?:^|\n)[ \t]*\n[ \t]*$/.test(before) ? '' : '\n\n';
  const trail = after === '' || after[0] === '\n' ? '' : '\n\n';
  return `${lead}$$\n${body.trim()}\n$$${trail}`;
}

/**
 * Rewrites the prose stretches of a message — everything outside fenced code and inline code
 * spans. Walks once; whatever it emits is final, so no later rule can undo it.
 */
function normalizeProse(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const character = text[i];

    // `\[…\]` and `\(…\)` are LaTeX delimiters remark-math does not know, so they are converted
    // here — before CommonMark can eat the backslashes and leave a bare `[ … ]` behind.
    if (character === '\\' && (text[i + 1] === '[' || text[i + 1] === '(')) {
      const closer = text[i + 1] === '[' ? '\\]' : '\\)';
      const end = text.indexOf(closer, i + 2);
      if (end >= 0) {
        const body = text.slice(i + 2, end);
        out += looksLikeProse(body) ? normalizeProse(body)
          : (closer === '\\]' || body.includes('\n') ? display(text, i, end + 2, body) : `$${body.trim()}$`);
        i = end + 2;
        continue;
      }
    }

    // A `$` that already carries a backslash is one this pass escaped on an earlier render, or one
    // the model escaped itself. Escaping it again is how `\$5.00` becomes `\\$5.00`, and a reply is
    // re-normalized on every streamed character.
    if (character === '$' && text[i - 1] !== '\\') {
      const doubled = text[i + 1] === '$';
      const opener = doubled ? i + 2 : i + 1;
      let close = -1;
      for (let k = opener; k < text.length; k += 1) {
        if (text[k] === '\n' && !doubled) break;
        if (text[k] === '$' && text[k - 1] !== '\\') {
          if (!doubled) { if (text[k + 1] === '$' || text[k - 1] === '$') continue; }
          else if (!text.startsWith('$$', k)) continue;
          close = k;
          break;
        }
      }
      if (close < 0) {
        // A single `$` with no partner is a price, not a delimiter. Escaped rather than emitted
        // raw: two of them on one line is all remark-math needs to pair up `$20 和 $1,000` into a
        // formula, and the escape is what stops a sentence about money from becoming math.
        if (!doubled) { out += '\\$'; i += 1; continue; }
        // An unclosed `$$` is a reply still arriving. Rather than leave the delimiter for
        // remark-math to close at the end of the message — which would put the formulas and prose
        // that follow inside the formula — the block is closed here, at the blank line that ends
        // the derivation. A tail that is prose at all means the `$$` was stray, and it goes.
        const tail = text.slice(opener);
        if (looksLikeProse(tail)) { i += 2; continue; }
        const stop = /\n[ \t]*\n/.exec(tail)?.index ?? tail.length;
        // A model that opened with `$$` and closed with one `$` leaves that `$` as the last thing
        // in the formula, where KaTeX rejects it as a function. It is the closer, so it goes.
        const body = tail.slice(0, stop).replace(/\$+[ \t]*$/, '');
        out += display(text, i, opener + stop, body);
        i = opener + stop;
        continue;
      }
      const body = text.slice(opener, close);
      const after = close + (doubled ? 2 : 1);
      if (looksLikeProse(body)) {
        // A `$$` pair the model misplaced: the delimiters go and the body is re-read, so the
        // headings and formulas inside it render as themselves instead of as one error. A single
        // `$` is different — the `$` that closed this candidate may be the opening of a real
        // formula, so only the one under the cursor is escaped and the scan carries on from it.
        if (!doubled) { out += '\\$'; i += 1; continue; }
        out += normalizeProse(body);
        i = after;
        continue;
      }
      // A display block is one whose `$$` sit alone on their lines. `设 $$y = x^2$$ 为抛物线` is
      // inline math inside a sentence, and turning that into a block would cut the sentence in two.
      const lineStart = text.lastIndexOf('\n', i - 1) + 1;
      const onItsOwn = text.slice(lineStart, i).trim() === '';
      const endsLine = /^[ \t]*(?:\n|$)/.test(text.slice(after));
      out += doubled && body.includes('\n') || (doubled && onItsOwn && endsLine)
        ? display(text, i, after, body)
        : `$${body.trim()}$`;
      i = after;
      continue;
    }

    if (character === '\\' && /[a-zA-Z]/.test(text[i + 1] ?? '')) {
      const end = readMathRun(text, i);
      if (end !== null) {
        const run = text.slice(i, end);
        out += run.startsWith('\\begin{') ? display(text, i, end, run) : `$${run}$`;
        i = end;
        continue;
      }
    }

    out += character;
    i += 1;
  }
  return out;
}

/** Rewrites every stretch of a message that sits outside fenced code and inline code spans. */
export function normalizeMarkdown(content: string): string {
  const regions: CodeRegion[] = [];
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
      regions.push({ kind: 'prose', start: plainStart, end: position });
      regions.push({ kind: 'code', start: position, end: codeEnd });
      position = codeEnd;
      plainStart = position;
    } else position++;
  }
  regions.push({ kind: 'prose', start: plainStart, end: content.length });
  return regions.map((region) => region.kind === 'code'
    ? content.slice(region.start, region.end)
    : normalizeProse(content.slice(region.start, region.end))).join('');
}
