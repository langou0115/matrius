import {
  Check,
  FileSpreadsheet,
  FileText,
  Layers,
  Loader2,
  Presentation,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import {
  hostRawFileUrl,
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

function OfficeSaveToolbar({
  canEdit,
  dirty,
  saving,
  savedNotice,
  error,
  readOnlyHint,
  onSave,
}: {
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  savedNotice: boolean;
  error: string | null;
  readOnlyHint?: string;
  onSave: () => void;
}) {
  return (
    <div className="work-doc-office-bar">
      <div className="work-doc-office-status">
        {error ? (
          <span className="work-doc-office-error" role="alert">{error}</span>
        ) : !canEdit ? (
          <span className="work-doc-office-muted">{readOnlyHint ?? '只读预览'}</span>
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

      {canEdit && (
        <button
          type="button"
          className="work-doc-office-save-btn"
          disabled={!dirty || saving}
          aria-label="保存文档"
          onClick={onSave}
        >
          {saving
            ? <Loader2 size={13} strokeWidth={2} className="loading-spinner" aria-hidden="true" />
            : <Save size={13} strokeWidth={1.85} aria-hidden="true" />}
          <span>{saving ? '保存中…' : '保存'}</span>
        </button>
      )}
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
  const toolbarRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const superdocRef = useRef<{
    export: (params?: { triggerDownload?: boolean; exportedName?: string }) => Promise<Blob | void>;
    destroy: () => void;
  } | null>(null);
  const revisionRef = useRef<string | null>(null);
  const readyRef = useRef(false);

  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [isLegacy, setIsLegacy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const instance = superdocRef.current;
    const baseRevision = revisionRef.current;
    if (!instance || !baseRevision || !canEdit || saving) return;

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
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '保存 Word 文档失败。');
    } finally {
      setSaving(false);
    }
  }, [canEdit, name, path, projectId, request, saving]);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(false), 2500);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  useEffect(() => {
    if (!editorAutoSave || !canEdit || !dirty || saving || saveError) return;
    const timer = window.setTimeout(() => {
      void handleSave();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirty, editorAutoSave, handleSave, saveError, saving]);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let disposed = false;

    setLoading(true);
    setLoadError(null);
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
        const converted = response.headers.get('X-File-Converted') === '1';
        const blob = await response.blob();
        if (disposed || controller.signal.aborted) return;

        revisionRef.current = revision;
        const editable = !readOnly && !converted && Boolean(revision);
        setIsLegacy(converted);
        setCanEdit(editable);

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
          ...(editable && toolbarEl ? { toolbar: toolbarEl } : {}),
          document: fileObj,
          documentMode: editable ? 'editing' : 'viewing',
          onReady: () => {
            if (disposed) return;
            readyRef.current = true;
            setLoading(false);
          },
        });

        instance.on('editor-update', () => {
          if (!disposed && readyRef.current && editable) {
            setDirty(true);
            setSaveError(null);
          }
        });

        superdocRef.current = instance;
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : '无法加载 Word 文档。');
          setLoading(false);
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
        // Ignore cleanup errors from SuperDoc
      }
      superdocRef.current = null;
    };
  }, [demo, hostId, name, path, readOnly]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (canEdit && dirty && !saving) void handleSave();
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
      <OfficeSaveToolbar
        canEdit={canEdit}
        dirty={dirty}
        saving={saving}
        savedNotice={savedNotice}
        error={saveError}
        readOnlyHint={isLegacy ? '旧版 .doc 文件（只读预览）' : '只读预览'}
        onSave={() => void handleSave()}
      />
      {loadError ? (
        <p className="work-tree-error work-doc-office-notice" role="alert">{loadError}</p>
      ) : (
        <div className="work-doc-superdoc-wrap">
          {loading && (
            <div className="work-doc-office-loading" role="status">
              <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
              <span>正在加载 Word 文档…</span>
            </div>
          )}
          <div ref={toolbarRef} className="work-doc-superdoc-toolbar" hidden={!canEdit} />
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
  const containerRef = useRef<HTMLDivElement>(null);
  const univerDisposeRef = useRef<(() => void) | null>(null);
  const workbookSaveRef = useRef<(() => Record<string, unknown> | null) | null>(null);
  const revisionRef = useRef<string | null>(null);
  const readyRef = useRef(false);

  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [isLegacy, setIsLegacy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const getSnapshot = workbookSaveRef.current;
    const baseRevision = revisionRef.current;
    if (!getSnapshot || !baseRevision || !canEdit || saving) return;

    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const snapshot = getSnapshot();
      if (!snapshot) throw new Error('无法读取电子表格数据。');
      const res = await saveWorkExcelFile(request, projectId, { path, workbook: snapshot, baseRevision });
      revisionRef.current = res.revision;
      setDirty(false);
      setSavedNotice(true);
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
    if (!editorAutoSave || !canEdit || !dirty || saving || saveError) return;
    const timer = window.setTimeout(() => {
      void handleSave();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirty, editorAutoSave, handleSave, saveError, saving]);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let disposed = false;

    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setDirty(false);
    setSavedNotice(false);
    readyRef.current = false;
    revisionRef.current = null;

    async function mountExcel() {
      try {
        const doc = await readHostDocumentPreview(request, hostId, path, controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (doc.kind !== 'excel' || !doc.workbook) {
          throw new Error('无法解析 Excel 工作簿。');
        }

        revisionRef.current = doc.revision ?? null;
        const legacy = Boolean(doc.readOnlyLegacy);
        const editable = !readOnly && !legacy && Boolean(doc.revision);
        setIsLegacy(legacy);
        setCanEdit(editable);

        const [
          { createUniver, defaultTheme, LocaleType, mergeLocales },
          { UniverSheetsCorePreset },
          zhCNModule,
        ] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/preset-sheets-core'),
          import('@univerjs/preset-sheets-core/locales/zh-CN'),
          import('@univerjs/preset-sheets-core/lib/index.css'),
        ]);
        if (disposed || controller.signal.aborted) return;

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';

        const { univer, univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: {
            [LocaleType.ZH_CN]: mergeLocales(zhCNModule.default),
          },
          theme: defaultTheme,
          presets: [
            UniverSheetsCorePreset({
              container,
            }),
          ],
        });

        const workbook = univerAPI.createWorkbook(doc.workbook);
        if (!editable && typeof workbook.setEditable === 'function') {
          workbook.setEditable(false);
        }

        workbookSaveRef.current = () => {
          const activeWb = univerAPI.getActiveWorkbook();
          return activeWb ? (activeWb.save() as unknown as Record<string, unknown>) : null;
        };

        const disposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (command) => {
          if (disposed || !readyRef.current || !editable) return;
          if (
            command.type === 2
            && typeof command.id === 'string'
            && (command.id.startsWith('sheet.mutation.') || command.id.startsWith('doc.mutation.'))
          ) {
            setDirty(true);
            setSaveError(null);
          }
        });

        univerDisposeRef.current = () => {
          try {
            disposable?.dispose?.();
          } catch {
            // Ignore command listener dispose errors
          }
          try {
            univer.dispose();
          } catch {
            // Ignore Univer dispose errors
          }
        };

        readyRef.current = true;
        setLoading(false);
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : '无法加载 Excel 文件。');
          setLoading(false);
        }
      }
    }

    void mountExcel();

    return () => {
      disposed = true;
      controller.abort();
      readyRef.current = false;
      workbookSaveRef.current = null;
      univerDisposeRef.current?.();
      univerDisposeRef.current = null;
    };
  }, [demo, hostId, path, readOnly, request]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
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
      <OfficeSaveToolbar
        canEdit={canEdit}
        dirty={dirty}
        saving={saving}
        savedNotice={savedNotice}
        error={saveError}
        readOnlyHint={isLegacy ? '旧版 .xls 文件（只读预览）' : '只读预览'}
        onSave={() => void handleSave()}
      />
      {loadError ? (
        <p className="work-tree-error work-doc-office-notice" role="alert">{loadError}</p>
      ) : (
        <div className="work-doc-univer-wrap">
          {loading && (
            <div className="work-doc-office-loading" role="status">
              <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
              <span>正在加载 Excel 表格…</span>
            </div>
          )}
          <div ref={containerRef} className="work-doc-univer-canvas" />
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
  const hostRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<{ destroy: () => void } | null>(null);
  const bufferRef = useRef<ArrayBuffer | null>(null);
  const [mode, setMode] = useState<'list' | 'slide'>('list');
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState<string | null>(null);

  const renderBuffer = useCallback(async (arrayBuffer: ArrayBuffer, nextMode: 'list' | 'slide') => {
    const container = hostRef.current;
    if (!container) return;
    try {
      previewerRef.current?.destroy();
    } catch {
      // Ignore cleanup errors
    }
    previewerRef.current = null;
    container.innerHTML = '';

    const { init } = await import('pptx-preview');
    const availableWidth = container.clientWidth > 0 ? container.clientWidth - 48 : 900;
    const width = Math.min(960, Math.max(480, Math.floor(availableWidth)));
    const height = Math.round((width * 9) / 16);

    const previewer = init(container, { width, height, mode: nextMode });
    previewerRef.current = previewer;
    await previewer.preview(arrayBuffer);
  }, []);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let disposed = false;

    setLoading(true);
    setLoadError(null);
    bufferRef.current = null;

    async function loadPptx() {
      try {
        const response = await fetch(hostRawFileUrl(hostId, path), {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await readFetchError(response, '无法读取 PowerPoint 文件。'));
        }
        const arrayBuffer = await response.arrayBuffer();
        if (disposed || controller.signal.aborted) return;
        bufferRef.current = arrayBuffer;
        await renderBuffer(arrayBuffer, mode);
        if (!disposed) setLoading(false);
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : '无法渲染 PowerPoint 文件。');
          setLoading(false);
        }
      }
    }

    void loadPptx();

    return () => {
      disposed = true;
      controller.abort();
      try {
        previewerRef.current?.destroy();
      } catch {
        // Ignore cleanup errors
      }
      previewerRef.current = null;
    };
  }, [demo, hostId, path, renderBuffer, mode]);

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
      <div className="work-doc-office-bar">
        <div className="work-doc-office-status">
          <Presentation size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="work-doc-office-muted">只读预览</span>
        </div>
        <div className="work-doc-ppt-mode-switch" role="group" aria-label="幻灯片视图模式">
          <button
            type="button"
            aria-pressed={mode === 'list'}
            onClick={() => setMode('list')}
          >
            <Layers size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>列表</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'slide'}
            onClick={() => setMode('slide')}
          >
            <SlidersHorizontal size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>单页</span>
          </button>
        </div>
      </div>

      {loadError ? (
        <p className="work-tree-error work-doc-office-notice" role="alert">{loadError}</p>
      ) : (
        <div className="work-doc-pptx-scroll" tabIndex={0}>
          {loading && (
            <div className="work-doc-office-loading" role="status">
              <Loader2 size={18} strokeWidth={1.85} className="loading-spinner" aria-hidden="true" />
              <span>正在渲染幻灯片…</span>
            </div>
          )}
          <div ref={hostRef} className="work-doc-pptx-stage" />
        </div>
      )}
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
