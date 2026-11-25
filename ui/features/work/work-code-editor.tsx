import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldable,
  foldedRanges,
  indentOnInput,
  syntaxHighlighting,
  unfoldEffect,
} from '@codemirror/language';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  type Panel,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { Clipboard, Copy, Scissors } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const matriusHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'var(--cm-variable)' },
  { tag: [t.propertyName], color: 'var(--cm-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-function)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--cm-constant)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--foreground)' },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.self, t.namespace], color: 'var(--cm-type)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--cm-number)' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: 'var(--cm-operator)' },
  { tag: [t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--cm-regexp)' },
  { tag: [t.meta, t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: '700', color: 'var(--cm-heading)' },
  { tag: [t.string, t.inserted], color: 'var(--cm-string)' },
  { tag: [t.tagName], color: 'var(--cm-tag)' },
  { tag: [t.attributeName], color: 'var(--cm-attribute)' },
  { tag: t.invalid, color: 'var(--destructive)' },
]);

const matriusEditorTheme = EditorView.theme({
  '&': {
    position: 'relative',
    height: '100%',
    width: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: 'var(--work-editor-font-size, 14px)',
    fontFamily: 'Consolas, Menlo, Monaco, "Droid Sans Mono", "DejaVu Sans Mono", "Courier New", monospace',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: '1.55',
    overscrollBehavior: 'contain',
  },
  '.cm-content': {
    padding: '10px 16px 24px 0',
    caretColor: 'var(--foreground)',
  },
  '.cm-line': {
    padding: '0 2px 0 2px',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--foreground)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'color-mix(in srgb, var(--muted-text) 75%, transparent)',
    borderRight: 'none',
    paddingRight: '2px',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: '3ch',
    padding: '0 2px 0 12px',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.9em',
    transition: 'color 120ms ease',
  },
  '.cm-foldGutter': {
    width: '16px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    cursor: 'pointer',
  },
  '.cm-fold-marker': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    color: 'var(--muted-text)',
    opacity: '0',
    transition: 'opacity 140ms ease, color 120ms ease',
  },
  '.cm-gutters:hover .cm-fold-marker, .cm-fold-marker.is-closed': {
    opacity: '1',
  },
  '.cm-fold-marker:hover': {
    color: 'var(--foreground)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 7%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
    color: 'var(--muted-text)',
    borderRadius: '4px',
    padding: '0 5px',
    margin: '0 3px',
    fontSize: '0.85em',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 3.5%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 26%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 16%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, #f59e0b 28%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 42%, transparent)',
    outline: '1px solid var(--primary)',
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--primary) 45%, transparent)',
    borderRadius: '2px',
  },
  '.cm-panels': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--foreground)',
  },
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: '8px',
    right: '18px',
    left: 'auto',
    zIndex: '20',
    borderBottom: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--primary)',
    color: 'var(--primary-foreground, #fff)',
  },
});

export function languageExtensionForFilename(filename: string): Extension {
  const baseName = filename.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  const ext = baseName.includes('.') ? baseName.split('.').at(-1) ?? '' : '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return html();
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown();
    case 'py':
    case 'pyw':
      return python();
    case 'sql':
      return sql();
    case 'xml':
    case 'svg':
    case 'xhtml':
    case 'plist':
      return xml();
    case 'yml':
    case 'yaml':
      return yaml();
    case 'rs':
      return rust();
    case 'c':
    case 'h':
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
      return cpp();
    case 'java':
      return java();
    case 'go':
      return go();
    case 'php':
      return php();
    default:
      return [];
  }
}

function createFoldMarker(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = `cm-fold-marker${open ? ' is-open' : ' is-closed'}`;
  span.setAttribute('aria-label', open ? '折叠代码块' : '展开代码块');
  span.innerHTML = open
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.25L8 9.75L11.5 6.25"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.25 4.5L9.75 8L6.25 11.5"/></svg>';
  return span;
}

function toggleFoldOnLine(view: EditorView, lineFrom: number, lineTo: number): boolean {
  let unfolded = false;
  foldedRanges(view.state).between(lineFrom, lineTo, (from, to) => {
    if (from >= lineFrom && from <= lineTo) {
      view.dispatch({ effects: unfoldEffect.of({ from, to }) });
      unfolded = true;
    }
  });
  if (unfolded) return true;
  const range = foldable(view.state, lineFrom, lineTo);
  if (range) {
    view.dispatch({ effects: foldEffect.of(range) });
    return true;
  }
  return false;
}

function createVsCodeSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'work-cm-search';
  dom.setAttribute('role', 'region');
  dom.setAttribute('aria-label', '文件内查找');
  dom.addEventListener('contextmenu', (event) => event.stopPropagation());

  let showReplace = false;
  const isReadOnly = () => view.state.readOnly;

  const toggleReplaceBtn = document.createElement('button');
  toggleReplaceBtn.type = 'button';
  toggleReplaceBtn.className = 'work-cm-search-toggle-replace';
  toggleReplaceBtn.setAttribute('aria-label', '切换替换');
  toggleReplaceBtn.title = '切换替换';
  toggleReplaceBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5L9.5 8L6 11.5"/></svg>';

  const rows = document.createElement('div');
  rows.className = 'work-cm-search-rows';

  // Row 1: Find
  const findRow = document.createElement('div');
  findRow.className = 'work-cm-search-row';

  const findInputWrap = document.createElement('div');
  findInputWrap.className = 'work-cm-search-input-wrap';

  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.className = 'work-cm-search-input';
  findInput.placeholder = '查找';
  findInput.setAttribute('main-field', 'true');
  findInput.setAttribute('aria-label', '查找内容');

  const makeFlagBtn = (label: string, title: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'work-cm-search-flag';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-pressed', 'false');
    return btn;
  };
  const caseBtn = makeFlagBtn('Aa', '区分大小写');
  const wordBtn = makeFlagBtn('ab', '全词匹配');
  const regexBtn = makeFlagBtn('.*', '使用正则表达式');

  const flagsWrap = document.createElement('div');
  flagsWrap.className = 'work-cm-search-flags';
  flagsWrap.append(caseBtn, wordBtn, regexBtn);
  findInputWrap.append(findInput, flagsWrap);

  const countSpan = document.createElement('span');
  countSpan.className = 'work-cm-search-count';
  countSpan.setAttribute('aria-live', 'polite');

  const makeIconBtn = (ariaLabel: string, svg: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'work-cm-search-btn';
    btn.setAttribute('aria-label', ariaLabel);
    btn.title = ariaLabel;
    btn.innerHTML = svg;
    return btn;
  };
  const prevBtn = makeIconBtn('上一个匹配项 (Shift+Enter)', '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V3.5M4.25 7.25L8 3.5L11.75 7.25"/></svg>');
  const nextBtn = makeIconBtn('下一个匹配项 (Enter)', '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5V12.5M4.25 8.75L8 12.5L11.75 8.75"/></svg>');
  const closeBtn = makeIconBtn('关闭 (Esc)', '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"/></svg>');

  findRow.append(findInputWrap, countSpan, prevBtn, nextBtn, closeBtn);

  // Row 2: Replace
  const replaceRow = document.createElement('div');
  replaceRow.className = 'work-cm-search-row work-cm-replace-row';
  replaceRow.hidden = true;

  const replaceInput = document.createElement('input');
  replaceInput.type = 'text';
  replaceInput.className = 'work-cm-search-input work-cm-replace-input';
  replaceInput.placeholder = '替换';
  replaceInput.setAttribute('aria-label', '替换为');

  const replaceOneBtn = document.createElement('button');
  replaceOneBtn.type = 'button';
  replaceOneBtn.className = 'work-cm-search-text-btn';
  replaceOneBtn.textContent = '替换';
  replaceOneBtn.title = '替换当前匹配项';

  const replaceAllBtn = document.createElement('button');
  replaceAllBtn.type = 'button';
  replaceAllBtn.className = 'work-cm-search-text-btn';
  replaceAllBtn.textContent = '全部替换';
  replaceAllBtn.title = '替换全部匹配项';

  replaceRow.append(replaceInput, replaceOneBtn, replaceAllBtn);
  rows.append(findRow, replaceRow);
  dom.append(toggleReplaceBtn, rows);

  let caseSensitive = false;
  let wholeWord = false;
  let regexp = false;

  const commitQuery = () => {
    const query = new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive,
      wholeWord,
      regexp,
    });
    if (!query.eq(getSearchQuery(view.state))) {
      view.dispatch({ effects: setSearchQuery.of(query) });
    }
  };

  const syncCount = () => {
    const q = getSearchQuery(view.state);
    if (!q.search) {
      countSpan.textContent = '';
      countSpan.classList.remove('is-empty');
      return;
    }
    if (!q.valid) {
      countSpan.textContent = '无效正则';
      countSpan.classList.add('is-empty');
      return;
    }
    const cursor = q.getCursor(view.state.doc);
    let total = 0;
    let activeIdx = 0;
    const selFrom = view.state.selection.main.from;
    const selTo = view.state.selection.main.to;
    let next = cursor.next();
    while (!next.done && total < 1000) {
      total += 1;
      if (next.value.from === selFrom && next.value.to === selTo) {
        activeIdx = total;
      }
      next = cursor.next();
    }
    if (total === 0) {
      countSpan.textContent = '无结果';
      countSpan.classList.add('is-empty');
    } else {
      const totalLabel = total >= 1000 ? '999+' : String(total);
      countSpan.textContent = activeIdx > 0 ? `${activeIdx}/${totalLabel}` : `${totalLabel} 项`;
      countSpan.classList.remove('is-empty');
    }
  };

  const syncFromState = () => {
    const q = getSearchQuery(view.state);
    if (document.activeElement !== findInput && findInput.value !== q.search) {
      findInput.value = q.search;
    }
    if (document.activeElement !== replaceInput && replaceInput.value !== q.replace) {
      replaceInput.value = q.replace;
    }
    caseSensitive = q.caseSensitive;
    wholeWord = q.wholeWord;
    regexp = q.regexp;
    caseBtn.setAttribute('aria-pressed', String(caseSensitive));
    caseBtn.classList.toggle('is-active', caseSensitive);
    wordBtn.setAttribute('aria-pressed', String(wholeWord));
    wordBtn.classList.toggle('is-active', wholeWord);
    regexBtn.setAttribute('aria-pressed', String(regexp));
    regexBtn.classList.toggle('is-active', regexp);
    const ro = isReadOnly();
    toggleReplaceBtn.hidden = ro;
    replaceRow.hidden = ro || !showReplace;
    toggleReplaceBtn.classList.toggle('is-open', !ro && showReplace);
    syncCount();
  };

  toggleReplaceBtn.addEventListener('click', () => {
    if (isReadOnly()) return;
    showReplace = !showReplace;
    syncFromState();
    if (showReplace) replaceInput.focus();
  });

  findInput.addEventListener('input', () => {
    commitQuery();
    syncCount();
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitQuery();
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
      syncCount();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  replaceInput.addEventListener('input', commitQuery);
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitQuery();
      replaceNext(view);
      syncCount();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });

  caseBtn.addEventListener('click', () => { caseSensitive = !caseSensitive; commitQuery(); syncFromState(); });
  wordBtn.addEventListener('click', () => { wholeWord = !wholeWord; commitQuery(); syncFromState(); });
  regexBtn.addEventListener('click', () => { regexp = !regexp; commitQuery(); syncFromState(); });
  prevBtn.addEventListener('click', () => { commitQuery(); findPrevious(view); syncCount(); });
  nextBtn.addEventListener('click', () => { commitQuery(); findNext(view); syncCount(); });
  closeBtn.addEventListener('click', () => { closeSearchPanel(view); view.focus(); });
  replaceOneBtn.addEventListener('click', () => { commitQuery(); replaceNext(view); syncCount(); });
  replaceAllBtn.addEventListener('click', () => { commitQuery(); replaceAll(view); syncCount(); });

  dom.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'h' && !isReadOnly()) {
      event.preventDefault();
      showReplace = true;
      syncFromState();
      replaceInput.focus();
    }
  });

  syncFromState();

  return {
    dom,
    top: true,
    mount() {
      findInput.focus();
      findInput.select();
    },
    update() {
      syncFromState();
    },
  };
}

function supportsCodeMirrorDom(): boolean {
  return typeof window !== 'undefined'
    && typeof document !== 'undefined'
    && typeof document.createRange === 'function'
    && typeof window.getSelection === 'function'
    && typeof Range !== 'undefined'
    && typeof Range.prototype?.getClientRects === 'function';
}

export type CodeRevealTarget = {
  line: number;
  column?: number;
  token: number;
};

export type EditorViewSnapshot = {
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
};

const EDITOR_VIEW_STATE_KEY = 'matrius:work-editor-view-state';
const MAX_STORED_VIEW_STATES = 200;
const memoryViewStates = new Map<string, EditorViewSnapshot>();
let viewStatesHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function hydrateViewStates(): void {
  if (viewStatesHydrated) return;
  viewStatesHydrated = true;
  try {
    const raw = globalThis.localStorage?.getItem(EDITOR_VIEW_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Partial<EditorViewSnapshot>;
      if (
        typeof item.anchor === 'number' && Number.isFinite(item.anchor)
        && typeof item.head === 'number' && Number.isFinite(item.head)
        && typeof item.scrollTop === 'number' && Number.isFinite(item.scrollTop)
        && typeof item.scrollLeft === 'number' && Number.isFinite(item.scrollLeft)
      ) {
        memoryViewStates.set(key, {
          anchor: Math.max(0, Math.round(item.anchor)),
          head: Math.max(0, Math.round(item.head)),
          scrollTop: Math.max(0, item.scrollTop),
          scrollLeft: Math.max(0, item.scrollLeft),
        });
      }
    }
  } catch {
    // Ignore storage errors.
  }
}

function schedulePersistViewStates(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const entries = Array.from(memoryViewStates.entries()).slice(-MAX_STORED_VIEW_STATES);
      globalThis.localStorage?.setItem(EDITOR_VIEW_STATE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Ignore storage errors.
    }
  }, 250);
}

export function readEditorViewSnapshot(stateKey: string | undefined): EditorViewSnapshot | undefined {
  if (!stateKey) return undefined;
  hydrateViewStates();
  return memoryViewStates.get(stateKey);
}

export function saveEditorViewSnapshot(stateKey: string | undefined, snapshot: EditorViewSnapshot): void {
  if (!stateKey) return;
  hydrateViewStates();
  // Refresh LRU order.
  memoryViewStates.delete(stateKey);
  memoryViewStates.set(stateKey, snapshot);
  while (memoryViewStates.size > MAX_STORED_VIEW_STATES) {
    const oldest = memoryViewStates.keys().next().value;
    if (oldest !== undefined) memoryViewStates.delete(oldest);
    else break;
  }
  schedulePersistViewStates();
}

export function WorkCodeEditor({
  stateKey,
  filename,
  value,
  readOnly = false,
  autoFocus = false,
  revealTarget = null,
  onChange,
  onSave,
}: {
  stateKey?: string;
  filename: string;
  value: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  revealTarget?: CodeRevealTarget | null;
  onChange?: (next: string, composing: boolean) => void;
  onSave?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const composingRef = useRef(false);
  const initialValueRef = useRef(value);
  const canUseCodeMirror = supportsCodeMirrorDom();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!canUseCodeMirror || !hostRef.current) return;

    const extensions: Extension[] = [
      lineNumbers({
        domEventHandlers: {
          mousedown: (view, line, event) => {
            if ((event as MouseEvent).button !== 0) return false;
            return toggleFoldOnLine(view, line.from, line.to);
          },
        },
      }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ markerDOM: createFoldMarker }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(matriusHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true, createPanel: createVsCodeSearchPanel }),
      matriusEditorTheme,
      languageCompartment.current.of(languageExtensionForFilename(filename)),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
      EditorView.contentAttributes.of({
        'aria-label': readOnly ? `查看 ${filename}` : `编辑 ${filename}`,
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
        {
          key: 'Mod-f',
          run: (view) => openSearchPanel(view),
        },
        {
          key: 'Mod-h',
          run: (view) => {
            openSearchPanel(view);
            const toggle = view.dom.querySelector<HTMLButtonElement>('.work-cm-search-toggle-replace');
            if (toggle && !toggle.hidden && !toggle.classList.contains('is-open')) {
              toggle.click();
            }
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        compositionstart: () => {
          composingRef.current = true;
          return false;
        },
        compositionend: (_event, view) => {
          composingRef.current = false;
          onChangeRef.current?.(view.state.doc.toString(), false);
          return false;
        },
        contextmenu: (event, view) => {
          event.preventDefault();
          event.stopPropagation();
          const { from, to } = view.state.selection.main;
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            hasSelection: to > from,
          });
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString(), composingRef.current);
        }
        if ((update.selectionSet || update.docChanged) && stateKey) {
          const sel = update.state.selection.main;
          saveEditorViewSnapshot(stateKey, {
            anchor: sel.anchor,
            head: sel.head,
            scrollTop: update.view.scrollDOM.scrollTop,
            scrollLeft: update.view.scrollDOM.scrollLeft,
          });
        }
      }),
    ];

    const savedView = !revealTarget ? readEditorViewSnapshot(stateKey) : undefined;
    const docLength = initialValueRef.current.length;
    const initialSelection = savedView
      ? {
          anchor: Math.min(savedView.anchor, docLength),
          head: Math.min(savedView.head, docLength),
        }
      : undefined;

    const state = EditorState.create({
      doc: initialValueRef.current,
      ...(initialSelection ? { selection: initialSelection } : {}),
      extensions,
    });
    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;

    const handleScroll = () => {
      if (!stateKey) return;
      const sel = view.state.selection.main;
      saveEditorViewSnapshot(stateKey, {
        anchor: sel.anchor,
        head: sel.head,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      });
    };
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });

    let rafId: number | null = null;
    if (savedView && (savedView.scrollTop > 0 || savedView.scrollLeft > 0)) {
      rafId = window.requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = savedView.scrollTop;
        view.scrollDOM.scrollLeft = savedView.scrollLeft;
      });
    }

    if (autoFocus && !readOnly) {
      view.focus();
    }

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      if (stateKey) {
        const sel = view.state.selection.main;
        saveEditorViewSnapshot(stateKey, {
          anchor: sel.anchor,
          head: sel.head,
          scrollTop: view.scrollDOM.scrollTop,
          scrollLeft: view.scrollDOM.scrollLeft,
        });
      }
      view.destroy();
      viewRef.current = null;
    };
    // Mount once per component instance (WorkFilePreview keys by project+path).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseCodeMirror]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtensionForFilename(filename)),
    });
  }, [filename]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    const selection = view.state.selection;
    const maxPos = value.length;
    const anchor = Math.min(selection.main.anchor, maxPos);
    const head = Math.min(selection.main.head, maxPos);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor, head },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealTarget) return;
    const lineCount = view.state.doc.lines;
    const lineNum = Math.max(1, Math.min(lineCount, revealTarget.line));
    const lineInfo = view.state.doc.line(lineNum);
    const colOffset = Math.max(0, (revealTarget.column ?? 1) - 1);
    const pos = Math.min(lineInfo.from + colOffset, lineInfo.to);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }, [revealTarget, value]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!contextMenu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const left = Math.max(8, Math.min(contextMenu.x, vw - width - 8));
    const top = Math.max(8, Math.min(contextMenu.y, vh - height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  async function handleEditorCopy(cut = false) {
    setContextMenu(null);
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (to <= from) return;
    const selected = view.state.sliceDoc(from, to);
    try {
      await navigator.clipboard?.writeText(selected);
    } catch {
      // Ignore clipboard permission errors.
    }
    if (cut && !readOnly) {
      view.dispatch({ changes: { from, to, insert: '' } });
    }
    view.focus();
  }

  async function handleEditorPaste() {
    setContextMenu(null);
    const view = viewRef.current;
    if (!view || readOnly) return;
    try {
      const pasted = await navigator.clipboard?.readText();
      if (typeof pasted === 'string' && pasted.length > 0) {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: pasted },
          selection: { anchor: from + pasted.length },
        });
      }
    } catch {
      // Ignore clipboard permission errors.
    }
    view.focus();
  }

  if (!canUseCodeMirror) {
    return (
      <div className="work-cm-host work-cm-fallback" data-readonly={readOnly ? 'true' : 'false'}>
        <div className="cm-editor">
          {readOnly ? (
            <pre className="cm-content" aria-label={`查看 ${filename}`}>{value}</pre>
          ) : (
            <textarea
              className="cm-content"
              aria-label={`编辑 ${filename}`}
              value={value}
              data-value={value}
              onChange={(event) => onChange?.(event.target.value, false)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="work-cm-host" ref={hostRef}>
      {contextMenu && (
        <div
          ref={menuRef}
          className="conversation-menu work-editor-context-menu"
          role="menu"
          aria-label="编辑器操作"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            role="menuitem"
            type="button"
            disabled={readOnly || !contextMenu.hasSelection}
            onClick={() => void handleEditorCopy(true)}
          >
            <Scissors size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>剪切</span>
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={!contextMenu.hasSelection}
            onClick={() => void handleEditorCopy(false)}
          >
            <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>复制</span>
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={readOnly}
            onClick={() => void handleEditorPaste()}
          >
            <Clipboard size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>粘贴</span>
          </button>
        </div>
      )}
    </div>
  );
}
