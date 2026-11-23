import type { WorkEditorDiffLayout } from '@contract/work-projects';
import type { WorkGitDiff, WorkGitDiffRequest } from '@contract/work-git';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  AlignJustify,
  FileDiff,
  Minus,
  Plus,
  Undo2,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';

import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { useInstance } from '@/features/instance/instance-state';
import { readWorkGitCommitDiff, readWorkGitDiff } from './work-api';
import { useWorkState } from './work-state';
import {
  computeInlineDiffRanges,
  pairHunkLines,
  parseGitPatch,
  type DiffLine,
  type InlineDiffRange,
  type ParsedDiffFile,
} from './work-git-model';
import { highlightCodeLines, paintTokens, type HighlightToken } from './work-syntax';

const demoDiff: WorkGitDiff = {
  patch: 'diff --git a/example b/example\n@@ -1,2 +1,2 @@\n-Initial content\n+Updated content\n Unchanged content\n',
  truncated: false,
};

type FileHighlightMap = Record<string, {
  oldTokens: HighlightToken[][];
  newTokens: HighlightToken[][];
  oldIndexByLine: WeakMap<DiffLine, number>;
  newIndexByLine: WeakMap<DiffLine, number>;
}>;

function renderHighlightedCode(
  text: string,
  tokens: HighlightToken[] | undefined,
  inlineRange: InlineDiffRange | null,
): ReactNode {
  if (!text) return null;

  if (!tokens?.length) {
    if (!inlineRange) return text;
    const { start, end } = inlineRange;
    return (
      <>
        {text.slice(0, start)}
        <mark className="work-git-inline-mark">{text.slice(start, end)}</mark>
        {text.slice(end)}
      </>
    );
  }

  if (!inlineRange) return paintTokens(tokens);

  const { start, end } = inlineRange;
  const beforeTokens: HighlightToken[] = [];
  const changedTokens: HighlightToken[] = [];
  const afterTokens: HighlightToken[] = [];
  let offset = 0;

  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.content.length;
    offset = tokenEnd;

    if (tokenEnd <= start) {
      beforeTokens.push(token);
    } else if (tokenStart >= end) {
      afterTokens.push(token);
    } else {
      if (tokenStart < start) {
        beforeTokens.push({ ...token, content: token.content.slice(0, start - tokenStart) });
      }
      const overlapStart = Math.max(0, start - tokenStart);
      const overlapEnd = Math.min(token.content.length, end - tokenStart);
      if (overlapEnd > overlapStart) {
        changedTokens.push({ ...token, content: token.content.slice(overlapStart, overlapEnd) });
      }
      if (tokenEnd > end) {
        afterTokens.push({ ...token, content: token.content.slice(end - tokenStart) });
      }
    }
  }

  return (
    <>
      {beforeTokens.length > 0 && paintTokens(beforeTokens)}
      {changedTokens.length > 0 && (
        <mark className="work-git-inline-mark">{paintTokens(changedTokens)}</mark>
      )}
      {afterTokens.length > 0 && paintTokens(afterTokens)}
    </>
  );
}

function DiffCell({
  line,
  side,
  tokens,
  inlineRange,
}: {
  line?: DiffLine;
  side: 'before' | 'after';
  tokens?: HighlightToken[];
  inlineRange: InlineDiffRange | null;
}) {
  return (
    <div className={`work-git-diff-cell ${line?.type ?? 'gap'}`}>
      <span className="work-git-line-number" aria-hidden="true">{line?.[side]}</span>
      <code>{line ? renderHighlightedCode(line.text, tokens, inlineRange) : null}</code>
    </div>
  );
}

function fileStatusLabel(status: ParsedDiffFile['status']): string {
  return {
    added: '新增',
    deleted: '删除',
    renamed: '重命名',
    modified: '修改',
  }[status];
}

export function WorkGitDiffView({
  projectId,
  file,
  active,
  demo,
  refresh = 0,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onClose,
  busy,
}: {
  projectId: string;
  file: WorkGitDiffRequest | { oid: string; subject: string; path?: string };
  active: boolean;
  demo: boolean;
  refresh?: number;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
  onClose?: () => void;
  busy?: boolean;
}) {
  const { request } = useInstance();
  const [result, setResult] = useState<WorkGitDiff | null>(demo ? demoDiff : null);
  const [error, setError] = useState<string | null>(null);
  const { editorDiffLayout } = useWorkState();
  const [layoutOverride, setLayoutOverride] = useState<WorkEditorDiffLayout | null>(null);
  const split = (layoutOverride ?? editorDiffLayout) === 'split';
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [highlights, setHighlights] = useState<FileHighlightMap>({});

  const oid = 'oid' in file ? file.oid : undefined;
  const path = file.path;
  const scope = 'scope' in file ? file.scope : undefined;
  const title = 'subject' in file
    ? (path ? `${file.oid.slice(0, 7)} · ${path}` : `${file.oid.slice(0, 7)} · ${file.subject}`)
    : file.path;

  const parsed = useMemo(
    () => (result ? parseGitPatch(result.patch, result.truncated) : null),
    [result],
  );

  useEffect(() => {
    if (!active || demo) return;
    const controller = new AbortController();
    const pending = oid
      ? readWorkGitCommitDiff(request, projectId, oid, path, controller.signal)
      : path && scope
        ? readWorkGitDiff(request, projectId, { path, scope }, controller.signal)
        : null;
    void pending?.then(
      (value) => {
        if (!controller.signal.aborted) {
          setResult(value);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '无法读取文件差异。');
        }
      },
    );
    return () => controller.abort();
  }, [active, demo, oid, path, projectId, refresh, request, scope]);

  // Asynchronously syntax-highlight each file's old & new lines via Shiki
  useEffect(() => {
    if (!parsed?.files.length) return;
    let cancelled = false;

    async function runHighlight() {
      const entries: Array<[string, FileHighlightMap[string]]> = [];
      for (const diffFile of parsed!.files) {
        if (diffFile.isBinary || diffFile.hunks.length === 0) continue;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        const oldIndexByLine = new WeakMap<DiffLine, number>();
        const newIndexByLine = new WeakMap<DiffLine, number>();

        for (const hunk of diffFile.hunks) {
          for (const line of hunk.lines) {
            if (line.type === 'delete' || line.type === 'context') {
              oldIndexByLine.set(line, oldLines.length);
              oldLines.push(line.text);
            }
            if (line.type === 'add' || line.type === 'context') {
              newIndexByLine.set(line, newLines.length);
              newLines.push(line.text);
            }
          }
        }

        const [oldHi, newHi] = await Promise.all([
          highlightCodeLines(oldLines, diffFile.oldPath || diffFile.displayPath, 3000).catch(() => null),
          highlightCodeLines(newLines, diffFile.newPath || diffFile.displayPath, 3000).catch(() => null),
        ]);
        if (cancelled) return;
        if (oldHi || newHi) {
          entries.push([
            diffFile.displayPath,
            {
              oldTokens: oldHi?.tokens ?? [],
              newTokens: newHi?.tokens ?? [],
              oldIndexByLine,
              newIndexByLine,
            },
          ]);
        }
      }
      if (!cancelled && entries.length > 0) {
        setHighlights(Object.fromEntries(entries));
      }
    }

    void runHighlight();
    return () => { cancelled = true; };
  }, [parsed]);

  const oldLabel = oid ? '父提交' : scope === 'index' ? '上次提交' : '暂存区';
  const newLabel = oid ? '本次提交' : scope === 'index' ? '暂存区' : '工作区';

  const visibleFiles = useMemo(() => parsed?.files ?? [], [parsed]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const item of visibleFiles) {
      additions += item.additions;
      deletions += item.deletions;
    }
    return { additions, deletions };
  }, [visibleFiles]);

  const displayName = path ? path.split('/').at(-1) || path : title;
  const displayDir = path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <section className="work-git-review" aria-label={`${title} 的差异`}>
      {!oid && (
        <header className="work-git-review-title">
          {path ? (
            <span className="work-git-diff-file-icon" aria-hidden="true">
              <FileTypeIcon file={{ name: displayName, type: '' }} />
            </span>
          ) : (
            <FileDiff size={15} strokeWidth={1.75} aria-hidden="true" />
          )}
          <div className="work-git-review-heading" title={title}>
            <strong>{displayName}</strong>
            {displayDir && <span className="work-git-review-dir">{displayDir}</span>}
          </div>
          {parsed && (totals.additions > 0 || totals.deletions > 0) && (
            <span className="work-git-diff-stats" aria-label={`新增 ${totals.additions} 行，删除 ${totals.deletions} 行`}>
              {totals.additions > 0 && <span className="is-add">+{totals.additions}</span>}
              {totals.deletions > 0 && <span className="is-del">-{totals.deletions}</span>}
            </span>
          )}
          {path && scope === 'worktree' && onDiscardFile && (
            <button
              type="button"
              className="icon-button work-git-diff-action"
              aria-label={`放弃更改：${path}`}
              title="放弃更改"
              disabled={busy}
              onClick={() => onDiscardFile(path)}
            >
              <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {path && scope === 'worktree' && onStageFile && (
            <button
              type="button"
              className="icon-button work-git-diff-action"
              aria-label={`暂存更改：${path}`}
              title="暂存更改"
              disabled={busy}
              onClick={() => onStageFile(path)}
            >
              <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {path && scope === 'index' && onUnstageFile && (
            <button
              type="button"
              className="icon-button work-git-diff-action"
              aria-label={`取消暂存：${path}`}
              title="取消暂存"
              disabled={busy}
              onClick={() => onUnstageFile(path)}
            >
              <Minus size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <div className="work-git-review-modes" role="group" aria-label="差异布局">
            <button type="button" aria-pressed={split} onClick={() => setLayoutOverride('split')}>
              <Columns2 size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>并排</span>
            </button>
            <button type="button" aria-pressed={!split} onClick={() => setLayoutOverride('inline')}>
              <AlignJustify size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>行内</span>
            </button>
          </div>
          {onClose && (
            <button
              type="button"
              className="icon-button work-git-diff-action"
              aria-label="关闭差异视图"
              title="返回提交图"
              onClick={onClose}
            >
              <X size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </header>
      )}

      {oid && (
        <div className="work-git-commit-diff-bar">
          <div className="work-git-diff-labels-inline">
            <span>{oldLabel}</span>
            <span aria-hidden="true">→</span>
            <span>{newLabel}</span>
            {path && <span className="work-git-focused-file" title={path}>{path}</span>}
          </div>
          <div className="work-git-review-modes" role="group" aria-label="差异布局">
            <button type="button" aria-pressed={split} onClick={() => setLayoutOverride('split')}>
              <Columns2 size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>并排</span>
            </button>
            <button type="button" aria-pressed={!split} onClick={() => setLayoutOverride('inline')}>
              <AlignJustify size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>行内</span>
            </button>
          </div>
        </div>
      )}

      {!oid && (
        <div className={`work-git-diff-labels${split ? ' split' : ''}`}>
          <span>{oldLabel}</span>
          {!split && <span aria-hidden="true">→</span>}
          <span>{newLabel}</span>
        </div>
      )}

      {error ? (
        <p className="work-tree-error work-git-diff-notice" role="alert">{error}</p>
      ) : !parsed ? (
        <p className="work-tree-state work-git-diff-notice" role="status">正在读取差异…</p>
      ) : !visibleFiles.length || visibleFiles.every((item) => !item.hunks.length && !item.isBinary) ? (
        <p className="work-tree-state work-git-diff-notice">
          {result?.patch ? '此变更没有可显示的文本差异。' : '没有差异'}
        </p>
      ) : (
        <div className="work-git-diff-scroll" tabIndex={0}>
          <div className={`work-git-diff-code${split ? ' split' : ''}`}>
            {visibleFiles.map((diffFile) => {
              const showFileHeader = (!oid && visibleFiles.length > 1) || diffFile.status === 'renamed';
              const isCollapsed = Boolean(collapsedFiles[diffFile.displayPath]);
              const fileHi = highlights[diffFile.displayPath];
              const fileName = diffFile.displayPath.split('/').at(-1) || diffFile.displayPath;

              return (
                <section key={diffFile.displayPath} className="work-git-diff-file">
                  {showFileHeader && (
                    <button
                      type="button"
                      className="work-git-patch-file"
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsedFiles((prev) => ({
                        ...prev,
                        [diffFile.displayPath]: !isCollapsed,
                      }))}
                    >
                      {isCollapsed
                        ? <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                        : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
                      <span className="work-git-diff-file-icon" aria-hidden="true">
                        <FileTypeIcon file={{ name: fileName, type: '' }} />
                      </span>
                      <span className="work-git-patch-file-path">
                        {diffFile.status === 'renamed'
                          ? `${diffFile.oldPath} → ${diffFile.newPath}`
                          : diffFile.displayPath}
                      </span>
                      <span className={`work-git-patch-badge is-${diffFile.status}`}>
                        {fileStatusLabel(diffFile.status)}
                      </span>
                      <span className="work-git-diff-stats">
                        {diffFile.additions > 0 && <span className="is-add">+{diffFile.additions}</span>}
                        {diffFile.deletions > 0 && <span className="is-del">-{diffFile.deletions}</span>}
                      </span>
                    </button>
                  )}

                  {!isCollapsed && (
                    diffFile.isBinary ? (
                      <p className="work-tree-state work-git-diff-notice">二进制文件，无法显示文本差异。</p>
                    ) : (
                      diffFile.hunks.map((hunk, hunkIdx) => (
                        <Fragment key={hunkIdx}>
                          <div className="work-git-hunk">
                            <span className="work-git-hunk-range">{hunk.range}</span>
                            {hunk.context && <span className="work-git-hunk-context">{hunk.context}</span>}
                          </div>
                          {split
                            ? pairHunkLines(hunk.lines).map(([oldLine, newLine], rowIdx) => {
                                const inlineDiff = oldLine && newLine && oldLine.type === 'delete' && newLine.type === 'add'
                                  ? computeInlineDiffRanges(oldLine.text, newLine.text)
                                  : { oldChanged: null, newChanged: null };
                                const oldIdx = oldLine ? fileHi?.oldIndexByLine.get(oldLine) : undefined;
                                const newIdx = newLine ? fileHi?.newIndexByLine.get(newLine) : undefined;
                                const oldTokens = oldIdx !== undefined ? fileHi?.oldTokens[oldIdx] : undefined;
                                const newTokens = newIdx !== undefined ? fileHi?.newTokens[newIdx] : undefined;

                                return (
                                  <div className="work-git-diff-pair" key={rowIdx}>
                                    <DiffCell
                                      line={oldLine}
                                      side="before"
                                      tokens={oldTokens}
                                      inlineRange={inlineDiff.oldChanged}
                                    />
                                    <DiffCell
                                      line={newLine}
                                      side="after"
                                      tokens={newTokens}
                                      inlineRange={inlineDiff.newChanged}
                                    />
                                  </div>
                                );
                              })
                            : hunk.lines.map((line, rowIdx) => {
                                const tokenIdx = line.type === 'delete'
                                  ? fileHi?.oldIndexByLine.get(line)
                                  : fileHi?.newIndexByLine.get(line);
                                const tokens = tokenIdx !== undefined
                                  ? (line.type === 'delete' ? fileHi?.oldTokens[tokenIdx] : fileHi?.newTokens[tokenIdx])
                                  : undefined;

                                return (
                                  <div className={`work-git-diff-inline ${line.type}`} key={rowIdx}>
                                    <span className="work-git-line-number" aria-hidden="true">{line.before}</span>
                                    <span className="work-git-line-number" aria-hidden="true">{line.after}</span>
                                    <span className="work-git-diff-sign" aria-hidden="true">
                                      {line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ' '}
                                    </span>
                                    <code>{renderHighlightedCode(line.text, tokens, null)}</code>
                                  </div>
                                );
                              })}
                        </Fragment>
                      ))
                    )
                  )}
                </section>
              );
            })}
            {parsed.truncated && (
              <p className="work-tree-state work-git-diff-notice" role="status">差异较大，仅显示前一部分。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
