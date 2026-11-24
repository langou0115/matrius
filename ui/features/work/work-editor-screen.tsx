import {
  DEFAULT_WORK_EDITOR_FONT_SIZE,
  MAX_WORK_EDITOR_FONT_SIZE,
  MIN_WORK_EDITOR_FONT_SIZE,
  normalizeWorkEditorDiffLayout,
} from '@contract/work-projects';
import { AlertCircle, Columns2, Minus, Plus, Save, Type } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import { SelectField } from '@/components/web/select-field';
import { useInstance } from '@/features/instance/instance-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { useIsPreview } from '@/features/workspace/preview-context';
import { loadWorkSettings, saveWorkSettings, type WorkSettingsPayload } from './work-shell-preference';
import { getWorkState, setWorkEditorSettings, useWorkState } from './work-state';

type EditorSettings = Pick<WorkSettingsPayload, 'editorFontSize' | 'editorAutoSave' | 'editorDiffLayout'>;

const INVALID_NUMBER_KEYS = new Set(['e', 'E', '+', '-', '.']);

function parseExactFontSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < MIN_WORK_EDITOR_FONT_SIZE || parsed > MAX_WORK_EDITOR_FONT_SIZE) {
    return null;
  }
  return parsed;
}

function parseCommittedFontSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_WORK_EDITOR_FONT_SIZE, Math.max(MIN_WORK_EDITOR_FONT_SIZE, Math.round(parsed)));
}

export function WorkEditorScreen() {
  const { request, status } = useInstance();
  const preview = useIsPreview();
  const { editorFontSize, editorAutoSave, editorDiffLayout } = useWorkState();
  const [loaded, setLoaded] = useState(preview);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => String(editorFontSize));
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const mountedRef = useRef(true);
  const saveSeqRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
  const committedRef = useRef<EditorSettings>({ editorFontSize, editorAutoSave, editorDiffLayout });

  function updateDraft(next: string) {
    draftRef.current = next;
    setDraft(next);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editingRef.current) {
      updateDraft(String(editorFontSize));
    }
  }, [editorFontSize]);

  useEffect(() => {
    if (preview || status !== 'ready') return;
    let current = true;
    void loadWorkSettings(request).then((settings) => {
      if (!current) return;
      committedRef.current = {
        editorFontSize: settings.editorFontSize,
        editorAutoSave: settings.editorAutoSave,
        editorDiffLayout: settings.editorDiffLayout,
      };
      setWorkEditorSettings(settings);
      setLoaded(true);
    }, (reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : '无法读取编辑器设置。');
    });
    return () => { current = false; };
  }, [preview, request, status]);

  function update(patch: Partial<EditorSettings>) {
    const current = getWorkState();
    const optimistic: EditorSettings = {
      editorFontSize: patch.editorFontSize ?? current.editorFontSize,
      editorAutoSave: patch.editorAutoSave ?? current.editorAutoSave,
      editorDiffLayout: patch.editorDiffLayout ?? current.editorDiffLayout,
    };
    setError(null);
    setWorkEditorSettings(optimistic);
    if (preview) {
      committedRef.current = optimistic;
      return;
    }
    const seq = ++saveSeqRef.current;
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const saved = await saveWorkSettings(request, patch);
        committedRef.current = {
          editorFontSize: saved.editorFontSize,
          editorAutoSave: saved.editorAutoSave,
          editorDiffLayout: saved.editorDiffLayout,
        };
        if (seq === saveSeqRef.current) {
          setWorkEditorSettings(saved);
        }
      } catch (reason) {
        if (seq === saveSeqRef.current) {
          setWorkEditorSettings(committedRef.current);
          if (mountedRef.current && !editingRef.current) {
            updateDraft(String(committedRef.current.editorFontSize));
          }
        }
        if (mountedRef.current) {
          setError(reason instanceof Error ? reason.message : '保存编辑器设置失败。');
        }
      }
    });
  }

  const disabled = !loaded || (!preview && status !== 'ready');

  function stepFontSize(delta: number) {
    if (disabled) return;
    const base = parseCommittedFontSize(draftRef.current) ?? getWorkState().editorFontSize;
    const next = Math.min(MAX_WORK_EDITOR_FONT_SIZE, Math.max(MIN_WORK_EDITOR_FONT_SIZE, base + delta));
    updateDraft(String(next));
    if (next !== getWorkState().editorFontSize) {
      update({ editorFontSize: next });
    }
  }

  function commitFontSize() {
    const current = getWorkState().editorFontSize;
    const parsed = parseCommittedFontSize(draftRef.current);
    if (parsed === null) {
      updateDraft(String(current));
      return;
    }
    updateDraft(String(parsed));
    if (parsed !== current) {
      update({ editorFontSize: parsed });
    }
  }

  function handleFontSizeChange(event: ChangeEvent<HTMLInputElement>) {
    const nextRaw = event.target.value;
    updateDraft(nextRaw);
    const exact = parseExactFontSize(nextRaw);
    if (exact !== null && exact !== getWorkState().editorFontSize) {
      update({ editorFontSize: exact });
    }
  }

  function handleFontSizeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      stepFontSize(event.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitFontSize();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      skipBlurCommitRef.current = true;
      updateDraft(String(getWorkState().editorFontSize));
      event.currentTarget.blur();
      return;
    }
    if (INVALID_NUMBER_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
    }
  }

  const stepBase = parseCommittedFontSize(draft) ?? editorFontSize;

  return (
    <SettingsPage title="编辑器">
      <section className="settings-section" aria-labelledby="work-editor-heading">
        <h2 id="work-editor-heading">文本编辑</h2>
        <div className="settings-list memory-settings-list work-settings-list">
          <div className="settings-row" id="work-editor-font-size">
            <span className="settings-row-icon" aria-hidden="true"><Type size={19} strokeWidth={1.75} /></span>
            <div className="settings-row-copy">
              <label htmlFor="work-editor-font-size-input"><strong>字体大小</strong></label>
              <span className="settings-row-description">
                支持 {MIN_WORK_EDITOR_FONT_SIZE}–{MAX_WORK_EDITOR_FONT_SIZE} px（默认 {DEFAULT_WORK_EDITOR_FONT_SIZE} px）。
              </span>
            </div>
            <div className="settings-row-action work-settings-control">
              <div className={`work-editor-font-size-control${disabled ? ' is-disabled' : ''}`}>
                <button
                  type="button"
                  className="work-editor-font-size-step"
                  aria-label="减小字体大小"
                  disabled={disabled || stepBase <= MIN_WORK_EDITOR_FONT_SIZE}
                  onClick={() => stepFontSize(-1)}
                >
                  <Minus size={14} strokeWidth={1.9} aria-hidden="true" />
                </button>
                <div
                  className="work-editor-font-size-field"
                  onClick={() => inputRef.current?.focus()}
                >
                  <input
                    ref={inputRef}
                    id="work-editor-font-size-input"
                    className="work-editor-font-size-input"
                    type="number"
                    inputMode="numeric"
                    min={MIN_WORK_EDITOR_FONT_SIZE}
                    max={MAX_WORK_EDITOR_FONT_SIZE}
                    step={1}
                    value={draft}
                    disabled={disabled}
                    aria-label="字体大小"
                    onFocus={() => {
                      editingRef.current = true;
                    }}
                    onChange={handleFontSizeChange}
                    onKeyDown={handleFontSizeKeyDown}
                    onBlur={() => {
                      editingRef.current = false;
                      if (skipBlurCommitRef.current) {
                        skipBlurCommitRef.current = false;
                        return;
                      }
                      commitFontSize();
                    }}
                    onWheel={(event) => event.currentTarget.blur()}
                  />
                  <span className="work-editor-font-size-unit" aria-hidden="true">px</span>
                </div>
                <button
                  type="button"
                  className="work-editor-font-size-step"
                  aria-label="增大字体大小"
                  disabled={disabled || stepBase >= MAX_WORK_EDITOR_FONT_SIZE}
                  onClick={() => stepFontSize(1)}
                >
                  <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
          <div className="settings-row" id="work-editor-diff-layout">
            <span className="settings-row-icon" aria-hidden="true"><Columns2 size={19} strokeWidth={1.75} /></span>
            <div className="settings-row-copy">
              <strong>默认差异视图</strong>
              <span className="settings-row-description">在 Git 查看器中以行内或并排方式展示更改。</span>
            </div>
            <div className="settings-row-action work-settings-control work-editor-select-wrap">
              <SelectField
                label="默认差异视图"
                hideLabel
                value={editorDiffLayout}
                disabled={disabled}
                options={[{ id: 'inline', label: '行内' }, { id: 'split', label: '并排' }]}
                onChange={(id) => update({ editorDiffLayout: normalizeWorkEditorDiffLayout(id) })}
              />
            </div>
          </div>
          <div className="settings-row" id="work-editor-auto-save">
            <span className="settings-row-icon" aria-hidden="true"><Save size={19} strokeWidth={1.75} /></span>
            <div className="settings-row-copy">
              <strong>自动保存</strong>
              <span className="settings-row-description">停止输入后自动保存项目文件。</span>
            </div>
            <label className="model-switch-label">
              <input
                className="model-checkbox-input"
                type="checkbox"
                checked={editorAutoSave}
                disabled={disabled}
                aria-label="自动保存"
                onChange={(event) => update({ editorAutoSave: event.target.checked })}
              />
              <span className="toggle-switch" aria-hidden="true" />
            </label>
          </div>
        </div>
        {error && (
          <p className="settings-message is-error" role="alert">
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </section>
    </SettingsPage>
  );
}

export default WorkEditorScreen;
