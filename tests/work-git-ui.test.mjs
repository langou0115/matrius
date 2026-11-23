import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';
import { WorkGitView } from '../ui/features/work/work-git-view.tsx';
import {
  buildGitChangeTree,
  computeInlineDiffRanges,
  formatGitDate,
  layoutGitGraph,
  parseGitPatch,
  parseGitRefs,
} from '../ui/features/work/work-git-model.ts';

function setupDom() {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };

  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    window,
    document,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

test('layoutGitGraph preserves branch lane colors across merges and compacts freed lanes', () => {
  const nodes = [
    { oid: 'c4', parents: ['c3', 'c2'], refs: ['HEAD -> main'], subject: 'merge', author: 'A', date: '2026-11-22' },
    { oid: 'c2', parents: ['c1'], refs: ['feature/a'], subject: 'feat', author: 'A', date: '2026-11-21' },
    { oid: 'c3', parents: ['c1'], refs: ['origin/main'], subject: 'main-2', author: 'A', date: '2026-11-20' },
    { oid: 'c1', parents: ['c0'], refs: [], subject: 'base', author: 'A', date: '2026-11-19' },
  ];

  const graph = layoutGitGraph(nodes);
  assert.equal(graph.rows.length, 4);
  assert.equal(graph.rows[0].isHead, true);
  assert.equal(graph.rows[0].isMerge, true);
  assert.equal(graph.rows[0].lane, 0);
  // Feature commit stays on lane 1 with its own distinct color
  assert.equal(graph.rows[1].lane, 1);
  assert.notEqual(graph.rows[1].color, graph.rows[0].color);
  // Main stays straight on lane 0 with the exact same color as HEAD
  assert.equal(graph.rows[2].lane, 0);
  assert.equal(graph.rows[2].color, graph.rows[0].color);
  assert.equal(graph.rows[3].lane, 0);
  assert.equal(graph.rows[3].color, graph.rows[0].color);
  // c1 still points to c0 which isn't in nodes
  assert.equal(graph.hasTrailingEdges, true);
});

test('git model helpers parse refs, patch files, intraline diffs, and compressed tree folders', () => {
  const refs = parseGitRefs(['HEAD -> main', 'origin/main', 'tag: v1.0.0', 'feat/ui']);
  assert.deepEqual(refs.map((r) => r.kind), ['head', 'remote', 'tag', 'local']);
  assert.equal(refs[0].label, 'HEAD -> main');
  assert.equal(refs[2].label, 'v1.0.0');

  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@ function demo()',
    '-const value = 1;',
    '+const value = 2;',
    ' export { value };',
    'diff --git a/new.md b/new.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.md',
    '@@ -0,0 +1,1 @@',
    '+hello',
  ].join('\n');

  const parsed = parseGitPatch(patch, false);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].displayPath, 'src/a.ts');
  assert.equal(parsed.files[0].status, 'modified');
  assert.equal(parsed.files[0].additions, 1);
  assert.equal(parsed.files[0].deletions, 1);
  assert.equal(parsed.files[0].hunks[0].context, 'function demo()');
  assert.equal(parsed.files[1].status, 'added');

  const inline = computeInlineDiffRanges('const value = 1;', 'const value = 2;');
  assert.deepEqual(inline, {
    oldChanged: { start: 14, end: 15 },
    newChanged: { start: 14, end: 15 },
  });

  const tree = buildGitChangeTree([
    { change: { path: 'ui/features/work/a.tsx', index: '.', workingTree: 'M' }, code: 'M' },
    { change: { path: 'ui/features/work/b.tsx', index: '.', workingTree: '?' }, code: '?' },
    { change: { path: 'README.md', index: '.', workingTree: 'M' }, code: 'M' },
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].kind, 'folder');
  assert.equal(tree[0].name, 'ui/features/work');
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[1].kind, 'file');

  const now = Date.parse('2026-11-23T10:00:00Z');
  assert.equal(formatGitDate('2026-11-23T09:59:40Z', now), '刚刚');
  assert.equal(formatGitDate('2026-11-23T09:45:00Z', now), '15分钟前');
  assert.equal(formatGitDate('2026-11-23T07:00:00Z', now), '3小时前');
});

test('WorkGitView supports VS Code tree/list toggle, stage/unstage/discard, branch switcher, graph filter, and commit inspector', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: true },
          createElement(
            PreviewContext.Provider,
            { value: true },
            createElement(WorkGitView, { projectId: 'demo-proj', active: true }),
          ),
        ),
      );
    });

    // Switch to Tree View and verify compressed folder + files appear
    const viewToggle = dom.document.querySelector('button[aria-label="切换为树状视图"]');
    assert.ok(viewToggle);
    await act(async () => { viewToggle.click(); });
    assert.ok(dom.document.querySelector('.work-git-folder-row'));
    assert.equal(dom.document.querySelector('.work-git-folder-name')?.textContent, 'ui');

    // Switch back to List View
    const listToggle = dom.document.querySelector('button[aria-label="切换为列表视图"]');
    assert.ok(listToggle);
    await act(async () => { listToggle.click(); });
    assert.equal(dom.document.querySelector('.work-git-folder-row'), null);

    // Stage README.md in demo mode
    const stageReadmeBtn = dom.document.querySelector('button[aria-label="暂存更改：README.md"]');
    assert.ok(stageReadmeBtn);
    await act(async () => { stageReadmeBtn.click(); });
    assert.ok(dom.document.querySelector('button[aria-label="取消暂存：README.md"]'));

    // Unstage README.md back to Changes
    const unstageReadmeBtn = dom.document.querySelector('button[aria-label="取消暂存：README.md"]');
    await act(async () => { unstageReadmeBtn.click(); });
    assert.ok(dom.document.querySelector('button[aria-label="暂存更改：README.md"]'));

    // Open Discard confirmation dialog and confirm
    const discardBtn = dom.document.querySelector('button[aria-label="放弃更改：README.md"]');
    assert.ok(discardBtn);
    await act(async () => { discardBtn.click(); });
    const discardDialog = dom.document.querySelector('dialog.work-git-discard-dialog[open]');
    assert.ok(discardDialog);
    const confirmDiscard = discardDialog.querySelector('.danger-button');
    await act(async () => { confirmDiscard.click(); });
    assert.equal(dom.document.querySelector('.work-git-change button[title="README.md"]'), null);

    // Switch branches from Branch Switcher Dropdown
    const branchTrigger = dom.document.querySelector('button[aria-label="切换分支"]');
    assert.ok(branchTrigger);
    await act(async () => { branchTrigger.click(); });
    const branchPopover = dom.document.querySelector('.work-git-branch-popover[aria-label="切换分支"]');
    assert.ok(branchPopover);
    const featureBranchBtn = Array.from(branchPopover.querySelectorAll('.work-git-branch-option'))
      .find((btn) => btn.textContent?.includes('feature/editor'));
    assert.ok(featureBranchBtn);
    await act(async () => { featureBranchBtn.click(); });
    assert.equal(branchTrigger.querySelector('.work-git-branch-name')?.textContent, 'feature/editor');

    // Filter commits using Graph Branch Filter Dropdown
    const graphBranchTrigger = dom.document.querySelector('button[aria-label="按分支筛选提交"]');
    assert.ok(graphBranchTrigger);
    await act(async () => { graphBranchTrigger.click(); });
    const graphBranchPopover = dom.document.querySelector('.work-git-branch-popover[aria-label="按分支筛选提交"]');
    assert.ok(graphBranchPopover);
    const graphFeatureOpt = Array.from(graphBranchPopover.querySelectorAll('.work-git-branch-option'))
      .find((btn) => btn.textContent?.includes('feature/editor'));
    assert.ok(graphFeatureOpt);
    await act(async () => { graphFeatureOpt.click(); });
    assert.equal(dom.document.querySelectorAll('.work-git-graph-row').length, 2);

    // Reset Graph Branch Filter back to 全部分支
    await act(async () => { graphBranchTrigger.click(); });
    const allBranchesOpt = Array.from(dom.document.querySelectorAll('.work-git-branch-popover[aria-label="按分支筛选提交"] .work-git-branch-option'))
      .find((btn) => btn.textContent?.includes('全部分支'));
    assert.ok(allBranchesOpt);
    await act(async () => { allBranchesOpt.click(); });
    assert.equal(dom.document.querySelectorAll('.work-git-graph-row').length, 4);

    // Filter commits in Git Graph
    const filterInput = dom.document.querySelector('input[aria-label="筛选提交"]');
    assert.ok(filterInput);
    const filterKey = Object.keys(filterInput).find((key) => key.startsWith('__reactProps'));
    assert.ok(filterKey);
    await act(async () => {
      filterInput.value = '语法高亮';
      filterInput[filterKey].onChange({ target: filterInput });
    });
    assert.equal(dom.document.querySelectorAll('.work-git-graph-row').length, 1);
    await act(async () => { dom.document.querySelector('button[aria-label="清空筛选"]').click(); });
    assert.equal(dom.document.querySelectorAll('.work-git-graph-row').length, 4);

    // Click a commit -> opens split Commit Inspector while keeping Git Graph visible
    // and loads only the selected commit file instead of all files at once.
    await act(async () => { dom.document.querySelector('.work-git-graph-subject').click(); });
    assert.ok(dom.document.querySelector('.work-git-graph-pane'));
    assert.ok(dom.document.querySelector('.work-git-inspector'));
    assert.match(dom.document.querySelector('.work-git-inspector-header')?.textContent ?? '', /合并文件预览分支/u);
    const inspectorFiles = dom.document.querySelectorAll('.work-git-inspector-file');
    assert.equal(inspectorFiles.length, 2);
    assert.equal(inspectorFiles[0].getAttribute('aria-pressed'), 'true');
    assert.ok(dom.document.querySelector('.work-git-diff-inline.add code'));

    // Clicking a second file in the commit switches the single-file diff preview
    await act(async () => { inspectorFiles[1].click(); });
    assert.equal(dom.document.querySelectorAll('.work-git-inspector-file')[1].getAttribute('aria-pressed'), 'true');
    assert.match(dom.document.querySelector('.work-git-commit-diff-bar')?.textContent ?? '', /ui\/main\.tsx/u);

    // Maximize and close inspector
    await act(async () => { dom.document.querySelector('button[aria-label="最大化提交详情"]').click(); });
    assert.equal(dom.document.querySelector('.work-git-graph-pane'), null);
    await act(async () => { dom.document.querySelector('button[aria-label="关闭提交详情"]').click(); });
    assert.equal(dom.document.querySelector('.work-git-inspector'), null);
    assert.ok(dom.document.querySelector('.work-git-graph-pane'));
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});
