import {
  Check,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pencil,
  Presentation,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import {
  hostRawFileUrl,
  hostRenderPdfUrl,
  readHostDocumentPreview,
  saveWorkBinaryFile,
  saveWorkExcelFile,
} from './work-api';
import { useWorkState } from './work-state';

const AUTO_SAVE_DELAY_MS = 1500;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readFetchError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: string; message?: string; error?: { message?: string } };
    return data.error?.message ?? data.detail ?? data.message ?? fallback;
  } catch {
    return fallback;
  }
}

function PdfPreviewFrame({ src, title }: { src: string; title: string }) {
  const [loading, setLoading] = useState(true);
  return (
    <div className="work-doc-pdf-wrap">
      {loading && (
        <div className="work-doc-office-loading" role="status">
          <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
          <span>正在渲染高清文档预览…</span>
        </div>
      )}
      <iframe
        key={src}
        className="work-doc-pdf-frame"
        src={src}
        title={title}
        onLoad={() => setLoading(false)}
      />
    </div>
  );
}

export function WorkWordView({
  hostId,
  projectId,
  path,
  name,
  readOnly,
  demo,
}: {
  hostId: string;
  projectId: string;
  path: string;
  name: string;
  readOnly: boolean;
  demo: boolean;
}) {
  const { request } = useInstance();
  const { editorAutoSave } = useWorkState();
  const isLegacyDoc = name.toLowerCase().endsWith('.doc');
  const editableAllowed = !readOnly && !isLegacyDoc;

  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [pdfVersion, setPdfVersion] = useState(1);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const superdocRef = useRef<{
    export: (params?: { triggerDownload?: boolean; exportedName?: string }) => Promise<Blob | void>;
    destroy: () => void;
  } | null>(null);
  const revisionRef = useRef<string | null>(null);
  const readyRef = useRef(false);

  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const instance = superdocRef.current;
    const baseRevision = revisionRef.current;
    if (!instance || !baseRevision || !editableAllowed || saving) return;

    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const exported = await instance.export({ triggerDownload: false, exportedName: name });
      if (!(exported instanceof Blob)) {
        throw new Error('无法导出 Word 文档内容。');
      }
      const dataBase64 = await blobToBase64(exported);
      const res = await saveWorkBinaryFile(request, projectId, { path, dataBase64, baseRevision });
      revisionRef.current = res.revision;
      setDirty(false);
      setSavedNotice(true);
      setPdfVersion((v) => v + 1);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '保存 Word 文档失败。');
    } finally {
      setSaving(false);
    }
  }, [editableAllowed, name, path, projectId, request, saving]);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(false), 2500);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  useEffect(() => {
    if (mode !== 'edit' || !editorAutoSave || !editableAllowed || !dirty || saving || saveError) return;
    const timer = window.setTimeout(() => {
      void handleSave();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, editableAllowed, editorAutoSave, handleSave, mode, saveError, saving]);

  useEffect(() => {
    if (demo || mode !== 'edit') return;
    const controller = new AbortController();
    let disposed = false;

    setEditorLoading(true);
    setEditorError(null);
    setSaveError(null);
    setDirty(false);
    setSavedNotice(false);
    readyRef.current = false;
    revisionRef.current = null;

    async function mountWord() {
      try {
        const response = await fetch(hostRawFileUrl(hostId, path), {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await readFetchError(response, '无法读取 Word 文档。'));
        }
        const revision = response.headers.get('X-File-Revision');
        const blob = await response.blob();
        if (disposed || controller.signal.aborted) return;

        revisionRef.current = revision;

        const [{ SuperDoc }] = await Promise.all([
          import('superdoc'),
          import('superdoc/style.css'),
        ]);
        if (disposed || controller.signal.aborted) return;

        const editorEl = editorRef.current;
        const toolbarEl = toolbarRef.current;
        if (!editorEl) return;
        editorEl.innerHTML = '';
        if (toolbarEl) toolbarEl.innerHTML = '';

        const fileObj = new File([blob], name.endsWith('.docx') ? name : `${name}.docx`, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        const instance = new SuperDoc({
          selector: editorEl,
          ...(toolbarEl ? { toolbar: toolbarEl } : {}),
          document: fileObj,
          documentMode: 'editing',
          onReady: () => {
            if (disposed) return;
            readyRef.current = true;
            setEditorLoading(false);
          },
        });

        instance.on('editor-update', () => {
          if (!disposed && readyRef.current) {
            setDirty(true);
            setSaveError(null);
          }
        });

        superdocRef.current = instance;
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setEditorError(reason instanceof Error ? reason.message : '无法加载 Word 编辑器。');
          setEditorLoading(false);
        }
      }
    }

    void mountWord();

    return () => {
      disposed = true;
      controller.abort();
      readyRef.current = false;
      try {
        superdocRef.current?.destroy();
      } catch {
        // Ignore cleanup errors
      }
      superdocRef.current = null;
    };
  }, [demo, hostId, mode, name, path]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (mode === 'edit' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (editableAllowed && dirty && !saving) void handleSave();
    }
  }

  if (demo) {
    return (
      <div className="work-doc-pdf-demo" role="status">
        <FileText size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{name}</strong>
        <span>Word 文档编辑与预览（示例模式）</span>
      </div>
    );
  }

  return (
    <div className="work-doc-office-shell work-doc-office-light" onKeyDown={handleKeyDown}>
      <div className="work-doc-office-bar">
        <div className="work-doc-office-status">
          {saveError ? (
            <span className="work-doc-office-error" role="alert">{saveError}</span>
          ) : mode === 'preview' ? (
            <span className="work-doc-office-muted">
              {isLegacyDoc ? '旧版 .doc 文件（高清只读预览）' : '高清预览'}
            </span>
          ) : saving ? (
            <span className="work-doc-office-muted">
              <Loader2 size={13} strokeWidth={2} className="loading-spinner" aria-hidden="true" />
              正在保存…
            </span>
          ) : dirty ? (
            <span className="work-doc-office-dirty">有未保存的更改</span>
          ) : savedNotice ? (
            <span className="work-doc-office-saved">
              <Check size={13} strokeWidth={2} aria-hidden="true" />
              已保存
            </span>
          ) : (
            <span className="work-doc-office-muted">编辑模式 · Ctrl+S 保存</span>
          )}
        </div>

        <div className="work-doc-office-actions">
          {mode === 'edit' && editableAllowed && (
            <button
              type="button"
              className="work-doc-office-save-btn"
              disabled={!dirty || saving}
              aria-label="保存文档"
              onClick={() => void handleSave()}
            >
              {saving
                ? <Loader2 size={13} strokeWidth={2} className="loading-spinner" aria-hidden="true" />
                : <Save size={13} strokeWidth={1.85} aria-hidden="true" />}
              <span>{saving ? '保存中…' : '保存'}</span>
            </button>
          )}
          {editableAllowed && (
            <button
              type="button"
              className="work-doc-office-mode-btn"
              onClick={() => setMode((current) => (current === 'preview' ? 'edit' : 'preview'))}
            >
              {mode === 'preview' ? (
                <>
                  <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>编辑文档</span>
                </>
              ) : (
                <>
                  <Eye size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>高清预览</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {mode === 'preview' ? (
        <PdfPreviewFrame src={hostRenderPdfUrl(hostId, path, pdfVersion)} title={name} />
      ) : editorError ? (
        <p className="work-tree-error work-doc-office-notice" role="alert">{editorError}</p>
      ) : (
        <div className="work-doc-superdoc-wrap">
          {editorLoading && (
            <div className="work-doc-office-loading" role="status">
              <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
              <span>正在加载 Word 编辑器…</span>
            </div>
          )}
          <div ref={toolbarRef} className="work-doc-superdoc-toolbar" />
          <div ref={editorRef} className="work-doc-superdoc-canvas" />
        </div>
      )}
    </div>
  );
}

export function WorkExcelView({
  hostId,
  projectId,
  path,
  name,
  readOnly,
  demo,
}: {
  hostId: string;
  projectId: string;
  path: string;
  name: string;
  readOnly: boolean;
  demo: boolean;
}) {
  const { request } = useInstance();
  const { editorAutoSave } = useWorkState();
  const [mode, setMode] = useState<'sheet' | 'pdf'>('sheet');
  const [pdfVersion, setPdfVersion] = useState(1);

  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<{ getData: () => unknown[] } | null>(null);
  const revisionRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [isLegacy, setIsLegacy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const instance = sheetRef.current;
    const baseRevision = revisionRef.current;
    if (!instance || !baseRevision || !canEdit || saving) return;

    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const data = instance.getData();
      const res = await saveWorkExcelFile(request, projectId, {
        path,
        spreadsheet: Array.isArray(data) ? data : [data],
        baseRevision,
      });
      revisionRef.current = res.revision;
      setDirty(false);
      setSavedNotice(true);
      setPdfVersion((v) => v + 1);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '保存 Excel 文件失败。');
    } finally {
      setSaving(false);
    }
  }, [canEdit, path, projectId, request, saving]);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(false), 2500);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  useEffect(() => {
    if (mode !== 'sheet' || !editorAutoSave || !canEdit || !dirty || saving || saveError) return;
    const timer = window.setTimeout(() => {
      void handleSave();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirty, editorAutoSave, handleSave, mode, saveError, saving]);

  useEffect(() => {
    if (demo || mode !== 'sheet') return;
    const controller = new AbortController();
    let disposed = false;

    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setDirty(false);
    setSavedNotice(false);
    revisionRef.current = null;
    sheetRef.current = null;

    async function mountSpreadsheet() {
      try {
        const doc = await readHostDocumentPreview(request, hostId, path, controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (doc.kind !== 'excel' || !doc.spreadsheet) {
          throw new Error('无法解析 Excel 工作簿。');
        }

        revisionRef.current = doc.revision ?? null;
        const legacy = Boolean(doc.readOnlyLegacy);
        const editable = !readOnly && !legacy && Boolean(doc.revision);
        setIsLegacy(legacy);
        setCanEdit(editable);

        await import('x-data-spreadsheet/dist/xspreadsheet.css');
        // @ts-expect-error prebuilt dist bundle attaches window.x_spreadsheet without requiring less
        await import('x-data-spreadsheet/dist/xspreadsheet.js');
        // @ts-expect-error prebuilt locale bundle registers window.x_spreadsheet.$messages['zh-cn']
        await import('x-data-spreadsheet/dist/locale/zh-cn.js');
        if (disposed || controller.signal.aborted) return;

        type XSpreadsheetFactory = {
          (container: HTMLElement, options?: Record<string, unknown>): {
            loadData: (data: unknown) => unknown;
            getData: () => unknown[];
            change: (cb: () => void) => unknown;
          };
          locale?: (lang: string, messages?: unknown) => void;
          $messages?: Record<string, unknown>;
        };
        const factory = (window as unknown as { x_spreadsheet?: XSpreadsheetFactory }).x_spreadsheet;
        if (typeof factory !== 'function') {
          throw new Error('电子表格引擎初始化失败。');
        }
        if (typeof factory.locale === 'function' && factory.$messages?.['zh-cn']) {
          factory.locale('zh-cn', factory.$messages['zh-cn']);
        }

        const host = hostRef.current;
        const wrap = wrapRef.current;
        if (!host || !wrap) return;
        host.innerHTML = '';

        const instance = factory(host, {
          mode: editable ? 'edit' : 'read',
          showToolbar: editable,
          showGrid: true,
          showContextmenu: editable,
          showBottomBar: true,
          view: {
            height: () => Math.max(300, wrap.clientHeight || 600),
            width: () => Math.max(400, wrap.clientWidth || 960),
          },
        });

        instance.loadData(doc.spreadsheet);
        if (editable) {
          instance.change(() => {
            if (!disposed) {
              setDirty(true);
              setSaveError(null);
            }
          });
        }

        sheetRef.current = instance;
        setLoading(false);
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : '无法加载 Excel 表格。');
          setLoading(false);
        }
      }
    }

    void mountSpreadsheet();

    return () => {
      disposed = true;
      controller.abort();
      sheetRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [demo, hostId, mode, path, readOnly, request]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (mode === 'sheet' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (canEdit && dirty && !saving) void handleSave();
    }
  }

  if (demo) {
    return (
      <div className="work-doc-pdf-demo" role="status">
        <FileSpreadsheet size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{name}</strong>
        <span>Excel 电子表格编辑与预览（示例模式）</span>
      </div>
    );
  }

  return (
    <div className="work-doc-office-shell work-doc-office-light" onKeyDown={handleKeyDown}>
      <div className="work-doc-office-bar">
        <div className="work-doc-office-status">
          {saveError ? (
            <span className="work-doc-office-error" role="alert">{saveError}</span>
          ) : mode === 'pdf' ? (
            <span className="work-doc-office-muted">打印效果高清预览</span>
          ) : !canEdit ? (
            <span className="work-doc-office-muted">{isLegacy ? '旧版 .xls 文件（只读预览）' : '只读预览'}</span>
          ) : saving ? (
            <span className="work-doc-office-muted">
              <Loader2 size={13} strokeWidth={2} className="loading-spinner" aria-hidden="true" />
              正在保存…
            </span>
          ) : dirty ? (
            <span className="work-doc-office-dirty">有未保存的更改</span>
          ) : savedNotice ? (
            <span className="work-doc-office-saved">
              <Check size={13} strokeWidth={2} aria-hidden="true" />
              已保存
            </span>
          ) : (
            <span className="work-doc-office-muted">可编辑 · Ctrl+S 保存</span>
          )}
        </div>

        <div className="work-doc-office-actions">
          {mode === 'sheet' && canEdit && (
            <button
              type="button"
              className="work-doc-office-save-btn"
              disabled={!dirty || saving}
              aria-label="保存表格"
              onClick={() => void handleSave()}
            >
              {saving
                ? <Loader2 size={13} strokeWidth={2} className="loading-spinner" aria-hidden="true" />
                : <Save size={13} strokeWidth={1.85} aria-hidden="true" />}
              <span>{saving ? '保存中…' : '保存'}</span>
            </button>
          )}
          <button
            type="button"
            className="work-doc-office-mode-btn"
            onClick={() => setMode((current) => (current === 'sheet' ? 'pdf' : 'sheet'))}
          >
            {mode === 'sheet' ? (
              <>
                <Eye size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>打印预览</span>
              </>
            ) : (
              <>
                <FileSpreadsheet size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>返回表格</span>
              </>
            )}
          </button>
        </div>
      </div>

      {mode === 'pdf' ? (
        <PdfPreviewFrame src={hostRenderPdfUrl(hostId, path, pdfVersion)} title={name} />
      ) : loadError ? (
        <p className="work-tree-error work-doc-office-notice" role="alert">{loadError}</p>
      ) : (
        <div ref={wrapRef} className="work-doc-xspreadsheet-wrap">
          {loading && (
            <div className="work-doc-office-loading" role="status">
              <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
              <span>正在加载 Excel 表格…</span>
            </div>
          )}
          <div ref={hostRef} className="work-doc-xspreadsheet-canvas" />
        </div>
      )}
    </div>
  );
}

export function WorkPowerPointView({
  hostId,
  path,
  name,
  demo,
}: {
  hostId: string;
  path: string;
  name: string;
  demo: boolean;
}) {
  if (demo) {
    return (
      <div className="work-doc-pdf-demo" role="status">
        <Presentation size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{name}</strong>
        <span>PowerPoint 幻灯片预览（示例模式）</span>
      </div>
    );
  }

  return (
    <div className="work-doc-office-shell work-doc-office-light">
      <PdfPreviewFrame src={hostRenderPdfUrl(hostId, path)} title={name} />
    </div>
  );
}

export function WorkPdfView({
  hostId,
  path,
  name,
  demo,
}: {
  hostId: string;
  path: string;
  name: string;
  demo: boolean;
}) {
  if (demo) {
    return (
      <div className="work-doc-pdf-demo" role="status">
        <FileText size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{name}</strong>
        <span>PDF 渲染预览（示例模式）</span>
      </div>
    );
  }
  return (
    <iframe
      className="work-doc-pdf-frame"
      src={hostRawFileUrl(hostId, path)}
      title={name}
    />
  );
}
