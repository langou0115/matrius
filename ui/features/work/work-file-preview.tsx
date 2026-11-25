import {
  detectWorkDocumentFormat,
  type HostFilePreview,
  type WorkHostEntry,
} from '@contract/work-projects';
import { Code2, Eye } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { MessageContent } from '@/features/chat/components/message-content';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { readHostFilePreview } from './work-api';
import {
  WorkCodeEditor,
  readEditorViewSnapshot,
  saveEditorViewSnapshot,
  type CodeRevealTarget,
} from './work-code-editor';
import {
  WorkExcelView,
  WorkPdfView,
  WorkPowerPointView,
  WorkWordView,
} from './work-document-view';
import { useWorkFileSave } from './work-file-save';
import { getWorkState, isFileDraftDirty, setWorkFileDraft, type WorkFileDraft } from './work-state';

const exampleText: Record<string, string> = {
  'main.tsx': 'export function App() {\n  return <main>Matrius</main>;\n}\n',
  'package.json': '{\n  "name": "matrius",\n  "private": true\n}\n',
  'README.md': '# Matrius\n\nReact and TypeScript workspace.\n',
};

type PreviewState = HostFilePreview | { error: string };

export function WorkFilePreview({
  hostId, projectId, file, draft, fontSize, readOnly = false, revealTarget = null,
}: {
  hostId: string;
  projectId: string;
  file: WorkHostEntry;
  draft: WorkFileDraft | undefined;
  fontSize: number;
  readOnly?: boolean;
  revealTarget?: CodeRevealTarget | null;
}) {
  const { request } = useInstance();
  const demo = useIsPreview();
  const saveFile = useWorkFileSave();
  const docFormat = detectWorkDocumentFormat(file.name);
  const isPdf = docFormat === 'pdf';
  const isOfficeDoc = docFormat === 'word' || docFormat === 'excel' || docFormat === 'powerpoint';
  const isMarkdown = docFormat === 'markdown';

  const [markdownMode, setMarkdownMode] = useState<'preview' | 'edit'>(revealTarget ? 'edit' : 'preview');
  const [result, setResult] = useState<PreviewState | null>(null);
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const editorStateKey = `${projectId}:${file.path}`;
  const mdScrollKey = `${projectId}:md-preview:${file.path}`;

  useEffect(() => {
    if (isMarkdown && revealTarget) {
      setMarkdownMode('edit');
    }
  }, [isMarkdown, revealTarget]);

  useEffect(() => {
    if (!isMarkdown || markdownMode !== 'preview' || !mdScrollRef.current) return;
    const saved = readEditorViewSnapshot(mdScrollKey);
    if (saved && saved.scrollTop > 0) {
      mdScrollRef.current.scrollTop = saved.scrollTop;
    }
  }, [isMarkdown, markdownMode, mdScrollKey, result]);
  const saved = result && 'text' in result ? result : null;
  const base = draft?.base ?? saved;
  const canEdit = !isPdf && !isOfficeDoc && !readOnly && Boolean(base);
  const editing = canEdit && (!isMarkdown || markdownMode === 'edit');
  const text = draft?.text ?? (canEdit ? saved?.text.replace(/\r\n?/gu, '\n') : saved?.text) ?? '';

  useEffect(() => {
    if (isPdf || isOfficeDoc) return;
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
      if (demo || readOnly) return;
      const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
      if (current && !current.composing && !current.saving && !isFileDraftDirty(current)) {
        setWorkFileDraft(projectId, file.path, undefined, current);
      }
    }, (reason: unknown) => {
      if (!signal.aborted) setResult({ error: reason instanceof Error ? reason.message : '无法读取文件。' });
    });
    return () => controller.abort();
  }, [demo, file.name, file.path, hostId, isOfficeDoc, isPdf, projectId, readOnly, request]);

  useEffect(() => () => {
    if (readOnly || isOfficeDoc || isPdf) return;
    const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
    if (current?.composing) setWorkFileDraft(projectId, file.path, { ...current, composing: false }, current);
  }, [file.path, isOfficeDoc, isPdf, projectId, readOnly]);

  function updateText(next: string, composingNow: boolean) {
    if (!base) return;
    const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(file.path);
    setWorkFileDraft(projectId, file.path, {
      text: next,
      base: current?.base ?? base,
      saving: current?.saving,
      composing: composingNow,
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

      {isPdf ? (
        <WorkPdfView hostId={hostId} path={file.path} name={file.name} demo={demo} />
      ) : docFormat === 'word' ? (
        <WorkWordView
          key={`${hostId}:${file.path}`}
          hostId={hostId}
          projectId={projectId}
          path={file.path}
          name={file.name}
          readOnly={readOnly}
          demo={demo}
        />
      ) : docFormat === 'excel' ? (
        <WorkExcelView
          key={`${hostId}:${file.path}`}
          hostId={hostId}
          projectId={projectId}
          path={file.path}
          name={file.name}
          readOnly={readOnly}
          demo={demo}
        />
      ) : docFormat === 'powerpoint' ? (
        <WorkPowerPointView
          key={`${hostId}:${file.path}`}
          hostId={hostId}
          path={file.path}
          name={file.name}
          demo={demo}
        />
      ) : (
        <>
          {isMarkdown && saved && (
            <div className="work-doc-toolbar">
              <span className="work-doc-meta">
                {markdownMode === 'preview' ? 'Markdown 预览' : canEdit ? 'Markdown 编辑' : 'Markdown 源码'}
              </span>
              <button
                type="button"
                className="work-doc-mode-btn"
                aria-label={markdownMode === 'preview' ? (canEdit ? '切换到编辑器' : '查看源码') : '切换到预览'}
                onClick={() => setMarkdownMode((current) => (current === 'preview' ? 'edit' : 'preview'))}
              >
                {markdownMode === 'preview' ? (
                  <>
                    <Code2 size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{canEdit ? '编辑源码' : '查看源码'}</span>
                  </>
                ) : (
                  <>
                    <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>预览</span>
                  </>
                )}
              </button>
            </div>
          )}

          {isMarkdown && markdownMode === 'preview' && saved ? (
            <div
              ref={mdScrollRef}
              className="work-doc-markdown-scroll"
              tabIndex={0}
              onScroll={(event) => {
                saveEditorViewSnapshot(mdScrollKey, {
                  anchor: 0,
                  head: 0,
                  scrollTop: event.currentTarget.scrollTop,
                  scrollLeft: event.currentTarget.scrollLeft,
                });
              }}
            >
              <div className="work-doc-markdown">
                <MessageContent content={text} />
              </div>
            </div>
          ) : saved || base ? (
            <WorkCodeEditor
              stateKey={editorStateKey}
              filename={file.name}
              value={text}
              readOnly={!editing}
              autoFocus={editing}
              revealTarget={revealTarget}
              onChange={editing ? updateText : undefined}
              onSave={editing ? () => { void saveFile(projectId, file.path); } : undefined}
            />
          ) : result && 'error' in result ? (
            <p className="work-tree-error" role="alert">{result.error}</p>
          ) : (
            <p className="work-tree-state" role="status">正在读取文件…</p>
          )}
        </>
      )}
    </section>
  );
}
