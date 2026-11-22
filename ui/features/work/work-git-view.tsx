import type { WorkGitChange, WorkGitCommitNode, WorkGitDiffRequest, WorkGitDiffScope, WorkGitStatus } from '@contract/work-git';
import { ArrowDown, ArrowUp, CloudDownload, FileText, GitFork, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { commitWorkGit, fetchWorkGit, readWorkGit } from './work-api';
import { WorkGitGraph } from './work-git-graph';
import { WorkGitDiffView } from './work-git-diff';

const sampleStatus: WorkGitStatus = {
  root: '/home/dev/projects/matrius', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0,
  localBranches: ['main', 'feature/editor'], remoteBranches: ['origin/main', 'origin/feature/editor'],
  changes: [{ path: 'README.md', index: '.', workingTree: 'M' }, { path: 'ui/main.tsx', index: 'M', workingTree: '.' }],
};

function changeLabel(code: string): string {
  return ({ M: '修改', A: '新增', D: '删除', T: '类型变更', U: '冲突', '?': '未跟踪' } as Record<string, string>)[code] ?? code;
}

export function WorkGitView({ projectId, active }: { projectId: string; active: boolean }) {
  const { request } = useInstance();
  const demo = useIsPreview();
  const [status, setStatus] = useState<WorkGitStatus | null>(demo ? sampleStatus : null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const busy = committing || fetching;
  const [refresh, setRefresh] = useState(0);
  const [commit, setCommit] = useState<WorkGitCommitNode | null>(null);
  const [selection, setSelection] = useState<WorkGitDiffRequest | null>(null);
  const selectedChange = status?.changes.find(({ path }) => path === selection?.path);
  const selected = selectedChange && selection
    && (selection.scope === 'index' ? !['.', '?'].includes(selectedChange.index) : selectedChange.workingTree !== '.')
    ? selection : null;
  const paths = status?.changes.filter(({ path }) => checked.has(path)).map(({ path }) => path) ?? [];

  useEffect(() => {
    if (demo || !active || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const result = await readWorkGit(request, projectId, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(result);
        setLoadError(null);
        setChecked((previous) => new Set(result.changes.filter(({ path }) => previous.has(path)).map(({ path }) => path)));
      } catch (reason) {
        if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : '无法读取 Git 状态。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(update, 5000);
      }
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, busy, demo, projectId, refresh, request]);

  async function handleFetch() {
    if (busy || demo) return;
    setFetching(true);
    setCommitError(null);
    setNotice(null);
    try {
      setStatus(await fetchWorkGit(request, projectId));
      setLoadError(null);
      setNotice('已获取远程分支');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : '获取远程分支失败。');
    } finally {
      setFetching(false);
    }
  }

  async function handleCommit(event: FormEvent) {
    event.preventDefault();
    if (busy || loadError || !message.trim() || !paths.length) return;
    setCommitting(true);
    setCommitError(null);
    setNotice(null);
    try {
      const { oid } = demo ? { oid: 'demo' } : await commitWorkGit(request, projectId, { message: message.trim(), paths });
      if (demo) setStatus((previous) => previous && {
        ...previous, ahead: previous.ahead + 1, changes: previous.changes.filter(({ path }) => !paths.includes(path)),
      });
      setNotice(`已提交 ${oid}`);
      setRefresh((value) => value + 1);
      setMessage('');
      setChecked(new Set());
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : '提交失败。');
    } finally {
      setCommitting(false);
    }
  }

  const groups: { title: string; scope: WorkGitDiffScope; changes: WorkGitChange[] }[] = status ? [
    { title: '暂存的变更', scope: 'index', changes: status.changes.filter(({ index }) => index !== '.' && index !== '?') },
    { title: '工作区变更', scope: 'worktree', changes: status.changes.filter(({ workingTree }) => workingTree !== '.') },
  ] : [];

  return (
    <section className="work-git-view" role="tabpanel" aria-label="Git" hidden={!active}>
      <aside className="work-git-sidebar" aria-label="源代码管理">
        <header className="work-git-header">
          <button
            type="button"
            className="icon-button work-git-graph-button"
            aria-label="查看提交图"
            title="查看提交图"
            aria-pressed={Boolean(status && !selected && !commit)}
            disabled={!status}
            onClick={() => { setSelection(null); setCommit(null); }}
          >
            <GitFork size={16} aria-hidden="true" />
          </button>
          <strong title={status?.root}>{status?.branch ?? (status ? '分离的 HEAD' : 'Git')}</strong>
          <button type="button" className="icon-button" aria-label="刷新 Git 状态" title="刷新 Git 状态" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="获取远程分支" title="获取远程分支" disabled={busy || demo || !status || !!loadError} onClick={() => void handleFetch()}>
            <CloudDownload size={16} aria-hidden="true" />
          </button>
        </header>
        {status?.upstream && (
          <div className="work-git-upstream">
            <span title={status.upstream}>{status.upstream}</span>
            <span title="领先提交数"><ArrowUp size={12} aria-hidden="true" />{status.ahead}</span>
            <span title="落后提交数"><ArrowDown size={12} aria-hidden="true" />{status.behind}</span>
          </div>
        )}
        {loadError && <p className="work-tree-error" role="alert">{loadError}</p>}
        {!status && !loadError && <p className="work-tree-state" role="status">正在读取 Git 状态…</p>}
        {status && (
          <>
            <form className="work-git-submit" onSubmit={(event) => void handleCommit(event)}>
              <textarea className="text-field" placeholder="提交说明" aria-label="提交说明" maxLength={1000}
                value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
              <div className="work-git-commit-controls">
                <button type="submit" className="primary-button" disabled={busy || !!loadError || !paths.length || !message.trim()}>
                  {committing ? '正在提交…' : paths.length ? `提交 ${paths.length} 个文件` : '提交'}
                </button>
                <label>
                  <input type="checkbox" aria-label="选择全部变更" checked={paths.length > 0 && paths.length === status.changes.length}
                    disabled={busy || !status.changes.length}
                    onChange={(event) => setChecked(new Set(event.target.checked ? status.changes.map(({ path }) => path) : []))} />
                  全选
                </label>
              </div>
              {commitError && <p className="work-tree-error" role="alert">{commitError}</p>}
              {(fetching || notice) && <p className="work-tree-state" role="status">{fetching ? '正在获取远程分支…' : notice}</p>}
            </form>
            <div className="work-git-changes">
              {groups.map(({ title, scope, changes }) => (
                <details key={scope} className="work-git-group" open>
                  <summary>{title}<span>{changes.length}</span></summary>
                  {changes.map(({ path, index, workingTree }) => {
                    const code = scope === 'index' ? index : workingTree;
                    const isSelected = selected?.path === path && selected.scope === scope;
                    const slash = path.lastIndexOf('/');
                    return (
                      <div className={`work-git-change${isSelected ? ' is-selected' : ''}`} key={path}>
                        <input type="checkbox" aria-label={`选择 ${path} 进行提交`} checked={checked.has(path)} disabled={busy} onChange={(event) => {
                          const enabled = event.target.checked;
                          setChecked((previous) => {
                            const next = new Set(previous);
                            if (enabled) next.add(path);
                            else next.delete(path);
                            return next;
                          });
                        }} />
                        <button type="button" title={path} aria-pressed={isSelected} onClick={() => {
                          setCommit(null);
                          setSelection({ path, scope });
                          if (isSelected) setRefresh((value) => value + 1);
                        }}>
                          <FileText size={14} aria-hidden="true" />
                          <span className="work-git-filename">{path.slice(slash + 1) || path}</span>
                          {slash >= 0 && <span className="work-git-directory">{path.slice(0, slash)}</span>}
                          <span className="work-git-state-letter" data-change={code} title={changeLabel(code)}>{code === '?' ? 'U' : code}</span>
                        </button>
                      </div>
                    );
                  })}
                </details>
              ))}
              {!status.changes.length && <p className="work-tree-state">工作区干净</p>}
            </div>
            <div className="work-git-branches">
              <details className="work-git-group">
                <summary>本地分支<span>{status.localBranches.length}</span></summary>
                <ul>{status.localBranches.map((branch) => <li key={branch} aria-current={branch === status.branch ? 'true' : undefined}>{branch}</li>)}</ul>
              </details>
              <details className="work-git-group">
                <summary>远程跟踪分支<span>{status.remoteBranches.length}</span></summary>
                <ul>{status.remoteBranches.map((branch) => <li key={branch} aria-current={branch === status.upstream ? 'true' : undefined}>{branch}</li>)}</ul>
              </details>
            </div>
          </>
        )}
      </aside>
      {commit ? (
        <WorkGitDiffView key={commit.oid} projectId={projectId} file={commit} active={active} demo={demo} />
      ) : selected ? (
        <WorkGitDiffView key={JSON.stringify([selected.path, selected.scope, refresh])}
          projectId={projectId} file={selected} active={active} demo={demo} />
      ) : (
        status && active ? <WorkGitGraph key={`${projectId}:${refresh}`} projectId={projectId} demo={demo} onCommit={setCommit} /> : null
      )}
    </section>
  );
}
