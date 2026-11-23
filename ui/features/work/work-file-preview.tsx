import { LOCAL_WORK_HOST_ID, type HostFilePreview, type WorkHostEntry } from '@contract/work-projects';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { readHostFilePreview } from './work-api';
import { getWorkState, isFileDraftDirty, setWorkFileDraft, type WorkFileDraft } from './work-state';
import {
  MAX_HIGHLIGHT_LINES,
  highlightCodeLines,
  paintTokens,
  type HighlightToken,
  type HighlightedFile,
} from './work-syntax';

const exampleText: Record<string, string> = {
  'main.tsx': 'export function App() {\n  return <main>Matrius</main>;\n}\n',
  'package.json': '{\n  "name": "matrius",\n  "private": true\n}\n',
  'README.md': '# Matrius\n\nReact and TypeScript workspace.\n',
};

function retainLineColors(line: string, previous: string, tokens: HighlightToken[]): HighlightToken[] {
  let prefix = 0;
  const sharedLength = Math.min(line.length, previous.length);
  while (prefix < sharedLength && line[prefix] === previous[prefix]) prefix++;
  // Keep a surrogate pair together if the edit changed only one half of it.
  if (prefix > 0 && /[\uD800-\uDBFF]/u.test(line[prefix - 1])) prefix--;

  let suffix = 0;
  while (suffix < sharedLength - prefix && line.at(-suffix - 1) === previous.at(-suffix - 1)) suffix++;
  if (suffix && /[\uDC00-\uDFFF]/u.test(line[line.length - suffix])) suffix--;

  const replacedEnd = previous.length - suffix;
  const inserted = line.slice(prefix, line.length - suffix);
  let offset = 0;
  let assignedInsertion = false;

  return tokens.map((token) => {
    const start = offset;
    offset += token.content.length;
    const before = token.content.slice(0, Math.max(0, prefix - start));
    const after = token.content.slice(Math.max(0, replacedEnd - start));
    const insertHere = !assignedInsertion && prefix <= offset;
    if (insertHere) assignedInsertion = true;
    return { ...token, content: before + (insertHere ? inserted : '') + after };
  });
}

function paintLines(text: string, lines: string[], highlighted: HighlightedFile | null): ReactNode {
  if (!highlighted || lines.length > MAX_HIGHLIGHT_LINES) return text;

  const previous = highlighted.lines;
  const sharedLength = Math.min(previous.length, lines.length);
  let prefix = 0;
  while (prefix < sharedLength && previous[prefix] === lines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < sharedLength - prefix
    && previous[previous.length - suffix - 1] === lines[lines.length - suffix - 1]) suffix++;

  return lines.map((line, index) => {
    const alignedFromEnd = index >= lines.length - suffix;
    const previousIndex = alignedFromEnd ? index + previous.length - lines.length : index;
    const unchanged = index < prefix || alignedFromEnd;
    const tokens = previousIndex < previous.length - suffix ? highlighted.tokens[previousIndex] : undefined;
    const content = unchanged
      ? highlighted.painted[previousIndex]
      : tokens?.length ? paintTokens(retainLineColors(line, previous[previousIndex], tokens)) : line;
    return (
      <span key={index}>
        {index > 0 && '\n'}
        {content}
      </span>
    );
  });
}

type PreviewState = HostFilePreview | { error: string };

export function WorkFilePreview({
  hostId, projectId, file, draft, fontSize,
}: {
  hostId: string;
  projectId: string;
  file: WorkHostEntry;
  draft: WorkFileDraft | undefined;
  fontSize: number;
}) {
  const { request } = useInstance();
  const demo = useIsPreview();
  const [result, setResult] = useState<PreviewState | null>(null);
  const [highlighted, setHighlighted] = useState<HighlightedFile | null>(null);
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const saved = result && 'text' in result ? result : null;
  const base = draft?.base ?? saved;
  const editing = hostId === LOCAL_WORK_HOST_ID && Boolean(base);
  const text = draft?.text ?? (editing ? saved?.text.replace(/\r\n?/gu, '\n') : saved?.text) ?? '';
  const lines = useMemo(() => text.split(/\r\n?|\n/u), [text]);
  const painted = useMemo(() => paintLines(text, lines, highlighted), [highlighted, lines, text]);
  const numbers = useMemo(() => lines.map((_, index) => index + 1).join('\n'), [lines]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const preview = demo
      ? Promise.resolve({
          text: Object.hasOwn(exampleText, file.name) ? exampleText[file.name] : file.name + '\n',
          revision: 'demo',
        })
      : readHostFilePreview(request, hostId, file.path, signal);
    void preview.then((data) => {
      if (signal.aborted) return;
      setResult(data);
      if (demo) return;
      const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
      if (current && !current.composing && !current.saving && !isFileDraftDirty(current)) {
        setWorkFileDraft(projectId, file.path, undefined, current);
      }
    }, (reason: unknown) => {
      if (!signal.aborted) setResult({ error: reason instanceof Error ? reason.message : '无法读取文件。' });
    });
    return () => controller.abort();
  }, [demo, file.name, file.path, hostId, projectId, request]);

  useEffect(() => {
    if (!text) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void highlightCodeLines(lines, file.name).catch(() => null).then((content) => {
        if (current) setHighlighted(content);
      });
    }, editing ? 100 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [editing, file.name, lines, text]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => () => {
    const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
    if (current?.composing) setWorkFileDraft(projectId, file.path, { ...current, composing: false }, current);
  }, [file.path, projectId]);

  function updateText(next: string, composing: boolean) {
    if (!base) return;
    const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
    setWorkFileDraft(projectId, file.path, {
      text: next,
      base: current?.base ?? base,
      saving: current?.saving,
      composing,
    });
  }

  return (
    <section
      className="work-file-preview"
      role="tabpanel"
      aria-label={file.name}
      style={{ '--work-editor-font-size': `${fontSize}px` } as CSSProperties}
    >
      {draft?.error && <p className="work-tree-error" role="alert">{draft.error}</p>}
      {editing ? (
        <div className="work-code-editor" ref={editorRef}>
          <div className="work-code-gutter" aria-hidden="true"><pre>{numbers}</pre></div>
          <div className="work-code-input">
            <pre className="work-code-paint" aria-hidden="true">{painted}</pre>
            <textarea
              ref={inputRef}
              aria-label={`编辑 ${file.name}`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              value={text}
              onChange={(event) => updateText(event.target.value, composing.current)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={(event) => {
                composing.current = false;
                updateText(event.currentTarget.value, false);
              }}
              onScroll={(event) => {
                const { scrollLeft, scrollTop } = event.currentTarget;
                editorRef.current?.style.setProperty('--work-code-scroll-x', `${-scrollLeft}px`);
                editorRef.current?.style.setProperty('--work-code-scroll-y', `${-scrollTop}px`);
              }}
            />
          </div>
        </div>
      ) : saved ? (
        <div className="work-code-view" tabIndex={0}>
          <div className="work-code-gutter" aria-hidden="true"><pre>{numbers}</pre></div>
          <pre className="work-code-source"><code>{painted}</code></pre>
        </div>
      ) : result && 'error' in result ? (
        <p className="work-tree-error" role="alert">{result.error}</p>
      ) : (
        <p className="work-tree-state" role="status">正在读取文件…</p>
      )}
    </section>
  );
}
