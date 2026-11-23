import type { WorkGitCommitNode } from '@contract/work-git';
import { Check, Cloud, Copy, GitBranch, GitCommitHorizontal, Search, Tag, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { readWorkGitGraph } from './work-api';
import { GitBranchSelect } from './work-git-branch-select';
import {
  GIT_GRAPH_ROW_HEIGHT,
  authorColor,
  authorInitials,
  formatGitDate,
  formatGitFullDate,
  gitLaneX,
  layoutGitGraph,
  parseGitRefs,
} from './work-git-model';

const demoNodes: WorkGitCommitNode[] = [
  {
    oid: '9b832aa41e00d9b832aa41e00d9b832aa41e00d1',
    parents: ['8c125be02f11d8c125be02f11d8c125be02f11d2', '31a0bff90a33c31a0bff90a33c31a0bff90a33c3'],
    refs: ['HEAD -> main'],
    subject: '合并文件预览分支',
    body: '集成文件预览语法高亮与工作区 Git 视图。',
    author: 'Matrius',
    email: 'dev@matrius.local',
    date: '2026-11-22T14:20:00+08:00',
  },
  {
    oid: '31a0bff90a33c31a0bff90a33c31a0bff90a33c3',
    parents: ['14aa20288c44b14aa20288c44b14aa20288c44b4'],
    refs: ['feature/editor'],
    subject: '支持文件语法高亮',
    author: 'Matrius',
    email: 'dev@matrius.local',
    date: '2026-11-21T18:05:00+08:00',
  },
  {
    oid: '8c125be02f11d8c125be02f11d8c125be02f11d2',
    parents: ['14aa20288c44b14aa20288c44b14aa20288c44b4'],
    refs: ['origin/main'],
    subject: '完善工作区终端',
    author: 'Matrius',
    email: 'dev@matrius.local',
    date: '2026-11-20T11:30:00+08:00',
  },
  {
    oid: '14aa20288c44b14aa20288c44b14aa20288c44b4',
    parents: [],
    refs: ['tag: v0.1.0'],
    subject: '初始化工作区',
    author: 'Matrius',
    email: 'dev@matrius.local',
    date: '2026-11-19T09:00:00+08:00',
  },
];

function collectBranchOids(nodes: readonly WorkGitCommitNode[], targetBranch: string): Set<string> | null {
  const tipNode = nodes.find((node) => node.refs.some((ref) => (
    ref === targetBranch || ref === `HEAD -> ${targetBranch}`
  )));
  if (!tipNode) return null;
  const byOid = new Map(nodes.map((node) => [node.oid, node]));
  const reachable = new Set<string>();
  const queue = [tipNode.oid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const node = byOid.get(current);
    if (!node) continue;
    for (const parent of node.parents) {
      if (!reachable.has(parent)) queue.push(parent);
    }
  }
  return reachable;
}

export function WorkGitGraph({
  projectId,
  demo,
  refresh = 0,
  localBranches = [],
  remoteBranches = [],
  pendingChangeCount = 0,
  selectedOid = null,
  onCommit,
  onNodesLoaded,
}: {
  projectId: string;
  demo: boolean;
  refresh?: number;
  localBranches?: readonly string[];
  remoteBranches?: readonly string[];
  pendingChangeCount?: number;
  selectedOid?: string | null;
  onCommit: (node: WorkGitCommitNode) => void;
  onNodesLoaded?: (nodes: WorkGitCommitNode[]) => void;
}) {
  const { request } = useInstance();
  const fadeGradientId = useId();
  const [nodes, setNodes] = useState<WorkGitCommitNode[] | null>(demo ? demoNodes : null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterBranch, setFilterBranch] = useState<string | null>(null);
  const [copiedOid, setCopiedOid] = useState<string | null>(null);

  useEffect(() => {
    if (demo) {
      onNodesLoaded?.(demoNodes);
      return;
    }
    const controller = new AbortController();
    void readWorkGitGraph(request, projectId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setNodes(value);
          onNodesLoaded?.(value);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '无法读取提交历史。');
        }
      },
    );
    return () => controller.abort();
  }, [demo, onNodesLoaded, projectId, refresh, request]);

  useEffect(() => {
    if (!copiedOid) return;
    const timer = window.setTimeout(() => setCopiedOid(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedOid]);

  const activeFilterBranch = useMemo(() => {
    if (!filterBranch) return null;
    if (localBranches.includes(filterBranch) || remoteBranches.includes(filterBranch)) return filterBranch;
    return null;
  }, [filterBranch, localBranches, remoteBranches]);

  const branchOids = useMemo(
    () => (nodes && activeFilterBranch ? collectBranchOids(nodes, activeFilterBranch) : null),
    [activeFilterBranch, nodes],
  );

  const filteredNodes = useMemo(() => {
    if (!nodes) return [];
    const normalized = query.trim().toLowerCase();
    return nodes.filter((node) => {
      if (branchOids && !branchOids.has(node.oid)) return false;
      if (!normalized) return true;
      return (
        node.subject.toLowerCase().includes(normalized)
        || node.author.toLowerCase().includes(normalized)
        || node.oid.toLowerCase().includes(normalized)
        || node.refs.some((ref) => ref.toLowerCase().includes(normalized))
      );
    });
  }, [branchOids, nodes, query]);

  const graph = useMemo(() => layoutGitGraph(filteredNodes), [filteredNodes]);

  async function handleCopyOid(oid: string) {
    try {
      await navigator.clipboard?.writeText(oid);
      setCopiedOid(oid);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  }

  return (
    <section className="work-git-review work-git-graph-pane" aria-label="提交图">
      <header className="work-git-review-title work-git-graph-toolbar">
        <div className="work-git-graph-heading">
          <GitCommitHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
          <strong>提交图</strong>
          {nodes && (
            <span className="work-git-graph-caption">
              {filteredNodes.length !== nodes.length
                ? `${filteredNodes.length} / ${nodes.length}`
                : `${nodes.length} 个提交`}
            </span>
          )}
          {pendingChangeCount > 0 && (
            <span className="work-git-pending-pill">{pendingChangeCount} 项未提交变更</span>
          )}
        </div>
        <div className="work-git-graph-tools">
          {(localBranches.length > 0 || remoteBranches.length > 0) && (
            <GitBranchSelect
              className="is-compact"
              ariaLabel="按分支筛选提交"
              allOptionLabel="全部分支"
              value={activeFilterBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              onChange={setFilterBranch}
            />
          )}
          <div className="work-git-graph-search">
            <Search size={13} strokeWidth={1.75} aria-hidden="true" />
            <input
              type="search"
              aria-label="筛选提交"
              placeholder="筛选提交、作者或分支…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="icon-button work-git-search-clear"
                aria-label="清空筛选"
                onClick={() => setQuery('')}
              >
                <X size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </header>

      {error ? (
        <p className="work-tree-error work-git-diff-notice" role="alert">{error}</p>
      ) : !nodes ? (
        <p className="work-tree-state work-git-diff-notice" role="status">正在读取提交历史…</p>
      ) : !nodes.length ? (
        <p className="work-tree-state work-git-diff-notice">仓库还没有提交。</p>
      ) : !filteredNodes.length ? (
        <p className="work-tree-state work-git-diff-notice">没有匹配的提交记录。</p>
      ) : (
        <div className="work-git-graph-scroll">
          <div
            className="work-git-graph-columns"
            style={{ gridTemplateColumns: `${graph.width}px minmax(0, 1fr)` }}
            aria-hidden="true"
          >
            <span className="work-git-col-graph">图形</span>
            <div className="work-git-col-fields">
              <span className="work-git-col-desc">提交说明</span>
              <span className="work-git-col-author">作者</span>
              <span className="work-git-col-date">时间</span>
              <span className="work-git-col-hash">提交</span>
            </div>
          </div>

          <div className="work-git-graph-layout">
            <svg
              className="work-git-graph-lines"
              width={graph.width}
              height={graph.height}
              aria-hidden="true"
            >
              {graph.hasTrailingEdges && (
                <defs>
                  <linearGradient id={fadeGradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--background)" stopOpacity="0" />
                    <stop offset="100%" stopColor="var(--background)" stopOpacity="1" />
                  </linearGradient>
                </defs>
              )}
              {graph.rows.map((row, index) => {
                const cx = gitLaneX(row.lane);
                const cy = index * GIT_GRAPH_ROW_HEIGHT + GIT_GRAPH_ROW_HEIGHT / 2;
                return (
                  <g key={row.node.oid}>
                    {row.segments.map((seg, segIndex) => (
                      <path
                        key={segIndex}
                        d={seg.d}
                        stroke={seg.color}
                        fill="none"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                      />
                    ))}
                    {row.isHead ? (
                      <>
                        <circle
                          cx={cx}
                          cy={cy}
                          r="6.8"
                          fill={row.color}
                          fillOpacity="0.18"
                          stroke={row.color}
                          strokeWidth="1.25"
                        />
                        <circle
                          cx={cx}
                          cy={cy}
                          r="3.8"
                          fill={row.color}
                          stroke="var(--background)"
                          strokeWidth="1.5"
                        />
                      </>
                    ) : row.isMerge ? (
                      <>
                        <circle
                          cx={cx}
                          cy={cy}
                          r="4.5"
                          fill="var(--background)"
                          stroke={row.color}
                          strokeWidth="1.9"
                        />
                        <circle cx={cx} cy={cy} r="1.6" fill={row.color} />
                      </>
                    ) : (
                      <circle
                        cx={cx}
                        cy={cy}
                        r="3.8"
                        fill={row.color}
                        stroke="var(--background)"
                        strokeWidth="1.5"
                      />
                    )}
                  </g>
                );
              })}
              {graph.hasTrailingEdges && graph.height >= 16 && (
                <rect
                  x="0"
                  y={graph.height - 14}
                  width={graph.width}
                  height="14"
                  fill={`url(#${fadeGradientId})`}
                />
              )}
            </svg>

            <ol
              className="work-git-graph-list"
              style={{ gridTemplateColumns: `${graph.width}px minmax(0, 1fr)` }}
            >
              {graph.rows.map((row) => {
                const { node } = row;
                const parsedRefs = parseGitRefs(node.refs, remoteBranches);
                const isSelected = selectedOid === node.oid;

                return (
                  <li
                    key={row.node.oid}
                    className={`work-git-graph-row${isSelected ? ' is-selected' : ''}${row.isHead ? ' is-head' : ''}`}
                    style={{ '--git-lane-color': row.color } as CSSProperties}
                    onClick={() => onCommit(node)}
                  >
                    <div className="work-git-graph-main">
                      {parsedRefs.length > 0 && (
                        <div className="work-git-ref-list">
                          {parsedRefs.map((ref) => (
                            <span
                              key={ref.raw}
                              className={`work-git-ref is-${ref.kind}${ref.kind === 'head' ? ' current' : ''}`}
                              title={ref.raw}
                            >
                              {ref.kind === 'tag'
                                ? <Tag size={10} strokeWidth={1.75} aria-hidden="true" />
                                : ref.kind === 'remote'
                                  ? <Cloud size={10} strokeWidth={1.75} aria-hidden="true" />
                                  : <GitBranch size={10} strokeWidth={1.75} aria-hidden="true" />}
                              <span className="work-git-ref-label">{ref.label}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        className="work-git-graph-subject"
                        title={node.subject}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCommit(node);
                        }}
                      >
                        {node.subject || '无提交说明'}
                      </button>
                    </div>

                    <span
                      className="work-git-graph-meta work-git-graph-author"
                      title={node.email ? `${node.author} <${node.email}>` : node.author}
                    >
                      <span
                        className="work-git-author-avatar"
                        style={{ background: authorColor(node.author) }}
                        aria-hidden="true"
                      >
                        {authorInitials(node.author)}
                      </span>
                      <span className="work-git-author-name">{node.author}</span>
                    </span>

                    <time
                      className="work-git-graph-meta work-git-graph-date"
                      dateTime={node.date}
                      title={formatGitFullDate(node.date)}
                    >
                      {formatGitDate(node.date)}
                    </time>

                    <span className="work-git-graph-hash-wrap">
                      <code className="work-git-graph-hash" title={node.oid}>
                        {node.oid.slice(0, 7)}
                      </code>
                      <button
                        type="button"
                        className="icon-button work-git-copy-oid"
                        aria-label={`复制提交哈希 ${node.oid.slice(0, 7)}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCopyOid(node.oid);
                        }}
                      >
                        {copiedOid === node.oid
                          ? <Check size={11} strokeWidth={2} aria-hidden="true" />
                          : <Copy size={11} strokeWidth={1.75} aria-hidden="true" />}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
