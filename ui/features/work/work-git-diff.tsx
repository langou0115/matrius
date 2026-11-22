import type { WorkGitDiff, WorkGitDiffRequest } from '@contract/work-git';
import { FileDiff } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { readWorkGitCommitDiff, readWorkGitDiff } from './work-api';

type Line = { type: 'context' | 'delete' | 'add'; text: string; before?: number; after?: number };
type Hunk = { title: string; lines: Line[]; file?: boolean };

const MAX_DISPLAY_LINES = 2500;
const demoDiff: WorkGitDiff = {
  patch: 'diff --git a/example b/example\n@@ -1,2 +1,2 @@\n-Initial content\n+Updated content\n Unchanged content\n',
  truncated: false,
};

function parseDiff({ patch, truncated }: WorkGitDiff) {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let before = 0;
  let after = 0;
  let displayLines = 0;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (raw.startsWith('diff --git ')) {
      hunks.push({ title: raw.slice(11), lines: [], file: true });
      hunk = undefined;
    } else if (header) {
      before = Number(header[1]);
      after = Number(header[2]);
      hunk = { title: raw, lines: [] };
      hunks.push(hunk);
    } else if (hunk && (raw.startsWith(' ') || raw.startsWith('-') || raw.startsWith('+'))) {
      if (displayLines++ >= MAX_DISPLAY_LINES) return { hunks, truncated: true };
      const text = raw.slice(1);
      if (raw[0] === '-') hunk.lines.push({ type: 'delete', text, before: before++ });
      else if (raw[0] === '+') hunk.lines.push({ type: 'add', text, after: after++ });
      else hunk.lines.push({ type: 'context', text, before: before++, after: after++ });
    }
  }
  return { hunks, truncated };
}

function pairLines(lines: Line[]): [Line | undefined, Line | undefined][] {
  const rows: [Line | undefined, Line | undefined][] = [];
  let deleted: Line[] = [];
  let added: Line[] = [];
  function flush() {
    for (let index = 0; index < Math.max(deleted.length, added.length); index++) {
      rows.push([deleted[index], added[index]]);
    }
    deleted = [];
    added = [];
  }
  for (const line of lines) {
    if (line.type === 'delete') deleted.push(line);
    else if (line.type === 'add') added.push(line);
    else {
      flush();
      rows.push([line, line]);
    }
  }
  flush();
  return rows;
}

function DiffCell({ line, side }: { line?: Line; side: 'before' | 'after' }) {
  return (
    <div className={`work-git-diff-cell ${line?.type ?? 'gap'}`}>
      <span className="work-git-line-number" aria-hidden="true">{line?.[side]}</span>
      <code>{line?.text}</code>
    </div>
  );
}

export function WorkGitDiffView({
  projectId, file, active, demo,
}: {
  projectId: string;
  file: WorkGitDiffRequest | { oid: string; subject: string };
  active: boolean;
  demo: boolean;
}) {
  const { request } = useInstance();
  const [result, setResult] = useState<WorkGitDiff | null>(demo ? demoDiff : null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const oid = 'oid' in file ? file.oid : undefined;
  const path = 'path' in file ? file.path : undefined;
  const scope = 'scope' in file ? file.scope : undefined;
  const title = 'subject' in file ? `${file.oid.slice(0, 7)} · ${file.subject}` : file.path;
  const parsed = useMemo(() => result ? parseDiff(result) : null, [result]);

  useEffect(() => {
    if (!active || demo) return;
    const controller = new AbortController();
    const pending = oid ? readWorkGitCommitDiff(request, projectId, oid, controller.signal)
      : path && scope ? readWorkGitDiff(request, projectId, { path, scope }, controller.signal) : null;
    void pending?.then((value) => {
      if (!controller.signal.aborted) {
        setResult(value);
        setError(null);
      }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取文件差异。');
    });
    return () => controller.abort();
  }, [active, demo, oid, path, projectId, request, scope]);

  const oldLabel = oid ? '父提交' : scope === 'index' ? '上次提交' : '暂存区';
  const newLabel = oid ? '本次提交' : scope === 'index' ? '暂存区' : '工作区';

  return (
    <section className="work-git-review" aria-label={`${title} 的差异`}>
      <header className="work-git-review-title">
        <FileDiff size={16} aria-hidden="true" />
        <strong title={title}>{title}</strong>
        <div className="work-git-review-modes" aria-label="差异布局">
          <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>并排</button>
          <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>行内</button>
        </div>
      </header>
      <div className={`work-git-diff-labels${split ? ' split' : ''}`}>
        <span>{oldLabel}</span>{!split && <span aria-hidden="true">→</span>}<span>{newLabel}</span>
      </div>
      {error ? <p className="work-tree-error" role="alert">{error}</p>
        : !parsed ? <p className="work-tree-state" role="status">正在读取差异…</p>
        : !parsed.hunks.length ? <p className="work-tree-state">{result?.patch ? '此变更没有可显示的文本差异。' : '没有差异'}</p>
        : (
          <div className="work-git-diff-scroll" tabIndex={0}>
            <div className={`work-git-diff-code${split ? ' split' : ''}`}>
              {parsed.hunks.map((hunk, index) => (
                <Fragment key={index}>
                  <div className={hunk.file ? 'work-git-hunk work-git-patch-file' : 'work-git-hunk'}>{hunk.title}</div>
                  {split ? pairLines(hunk.lines).map(([old, next], row) => (
                    <div className="work-git-diff-pair" key={row}>
                      <DiffCell line={old} side="before" />
                      <DiffCell line={next} side="after" />
                    </div>
                  )) : hunk.lines.map((line, row) => (
                    <div className={`work-git-diff-inline ${line.type}`} key={row}>
                      <span className="work-git-line-number" aria-hidden="true">{line.before}</span>
                      <span className="work-git-line-number" aria-hidden="true">{line.after}</span>
                      <span className="work-git-diff-sign" aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ' '}</span>
                      <code>{line.text}</code>
                    </div>
                  ))}
                </Fragment>
              ))}
              {parsed.truncated && <p className="work-tree-state" role="status">差异较大，仅显示前一部分。</p>}
            </div>
          </div>
        )}
    </section>
  );
}
