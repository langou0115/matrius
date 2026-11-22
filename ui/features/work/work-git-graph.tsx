import type { WorkGitCommitNode } from '@contract/work-git';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { readWorkGitGraph } from './work-api';

const demoNodes: WorkGitCommitNode[] = [
  { oid: '9b832aa', parents: ['8c125be', '31a0bff'], refs: ['HEAD -> main'], subject: '合并文件预览分支', author: 'Matrius', date: '2026-11-22' },
  { oid: '31a0bff', parents: ['14aa202'], refs: ['feature/editor'], subject: '支持文件语法高亮', author: 'Matrius', date: '2026-11-21' },
  { oid: '8c125be', parents: ['14aa202'], refs: ['origin/main'], subject: '完善工作区终端', author: 'Matrius', date: '2026-11-20' },
  { oid: '14aa202', parents: [], refs: [], subject: '初始化工作区', author: 'Matrius', date: '2026-11-19' },
];

const palette = ['#8569de', '#2c9b8f', '#c58137', '#568cd5', '#c76593'];
const rowHeight = 38;
const column = (lane: number) => 10 + lane * 14;

function layout(nodes: WorkGitCommitNode[]) {
  let lanes: string[] = [];
  let width = 1;
  const rows = nodes.map((node) => {
    if (!lanes.includes(node.oid)) lanes.push(node.oid);
    const before = lanes;
    const lane = before.indexOf(node.oid);
    lanes = before.filter((oid) => oid !== node.oid);
    for (const [index, parent] of node.parents.entries()) {
      if (!lanes.includes(parent)) lanes.splice(lane + index, 0, parent);
    }
    width = Math.max(width, before.length, lanes.length);
    const edges = before.flatMap((oid, index) => oid === node.oid
      ? node.parents.map((parent) => ({ from: lane, to: lanes.indexOf(parent), merge: true }))
      : [{ from: index, to: lanes.indexOf(oid), merge: false }]);
    return { node, lane, edges };
  });
  return { rows, width: column(width) };
}

export function WorkGitGraph({ projectId, demo, onCommit }: { projectId: string; demo: boolean; onCommit: (node: WorkGitCommitNode) => void }) {
  const { request } = useInstance();
  const [nodes, setNodes] = useState<WorkGitCommitNode[] | null>(demo ? demoNodes : null);
  const [error, setError] = useState<string | null>(null);
  const graph = useMemo(() => layout(nodes ?? []), [nodes]);
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    void readWorkGitGraph(request, projectId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setNodes(value);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取提交历史。');
    });
    return () => controller.abort();
  }, [demo, projectId, request]);

  return (
    <section className="work-git-review" aria-label="提交图">
      <header className="work-git-review-title"><GitCommitHorizontal size={16} aria-hidden="true" /><strong>提交图</strong>{nodes && <span className="work-git-graph-caption">{nodes.length} 个提交</span>}</header>
      {error ? <p className="work-tree-error" role="alert">{error}</p>
        : !nodes ? <p className="work-tree-state" role="status">正在读取提交历史…</p>
        : !nodes.length ? <p className="work-tree-state">仓库还没有提交。</p>
        : <div className="work-git-graph-scroll">
          <div className="work-git-graph-layout">
            <svg className="work-git-graph-lines" width={graph.width} height={nodes.length * rowHeight} aria-hidden="true">
              {graph.rows.map(({ node, lane, edges }, index) => {
                const y = index * rowHeight + rowHeight / 2;
                return <g key={node.oid}>
                  {index < graph.rows.length - 1 && edges.map(({ from, to, merge }, edge) => (
                    <path key={edge} d={`M ${column(from)} ${y} C ${column(from)} ${y + 19}, ${column(to)} ${y + 19}, ${column(to)} ${y + rowHeight}`}
                      stroke={palette[(merge ? to : from) % palette.length]} fill="none" strokeWidth="1.7" />
                  ))}
                  <circle cx={column(lane)} cy={y} r="4.5" fill={palette[lane % palette.length]} stroke="var(--background)" strokeWidth="1.5" />
                </g>;
              })}
            </svg>
            <ol className="work-git-graph-list" style={{ gridTemplateColumns: `${graph.width}px minmax(0, 1fr)` }}>
              {graph.rows.map(({ node }) => (
              <li key={node.oid} className="work-git-graph-row">
                <button type="button" className="work-git-graph-subject" title={node.subject} onClick={() => onCommit(node)}>{node.subject || '无提交说明'}</button>
                {node.refs.map((ref) => <span key={ref} className={`work-git-ref${ref.startsWith('HEAD') ? ' current' : ''}`} title={ref}><GitBranch size={11} aria-hidden="true" />{ref}</span>)}
                <span className="work-git-graph-meta" title={node.author}>{node.author}</span>
                <time className="work-git-graph-meta" dateTime={node.date}>{node.date.slice(0, 10)}</time>
                <code className="work-git-graph-hash" title={node.oid}>{node.oid.slice(0, 7)}</code>
              </li>
            ))}
            </ol>
          </div>
        </div>}
    </section>
  );
}
