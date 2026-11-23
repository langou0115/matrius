import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { openDatabase } from '../db/client';
import { migrate } from '../db/migrate';

test('project Git discovers branches, fetches tracking refs and commits only selected paths', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'matrius-git-work-'));
  const directory = join(temporary, 'project');
  mkdirSync(directory);
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: temporary, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);
  const { app } = await buildApp({ settings, db });

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test Author');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    writeFileSync(join(directory, 'staged.txt'), 'before');
    git('add', 'staged.txt');
    git('commit', '-m', 'Initial');
    git('branch', 'feature/editor');

    const remote = join(temporary, 'remote.git');
    git('clone', '--bare', '.', remote);
    git('remote', 'add', 'origin', remote);
    git('config', 'branch.main.remote', 'origin');
    git('config', 'branch.main.merge', 'refs/heads/main');
    writeFileSync(join(directory, 'staged.txt'), 'after');
    git('add', 'staged.txt');
    writeFileSync(join(directory, 'selected [literal].txt'), 'selected');

    const project = await app.inject({
      method: 'POST', url: '/api/projects', payload: { hostId: 'local', directory },
    });
    assert.equal(project.statusCode, 201, project.body);
    const url = `/api/projects/${project.json().id}/git`;
    const before = await app.inject({ url });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().branch, 'main');
    assert.deepEqual(before.json().localBranches, ['feature/editor', 'main']);
    assert.deepEqual(before.json().changes, [
      { path: 'staged.txt', index: 'M', workingTree: '.' },
      { path: 'selected [literal].txt', index: '?', workingTree: '?' },
    ]);

    writeFileSync(join(directory, 'staged.txt'), 'working');
    const diff = (path: string, scope: 'index' | 'worktree') => app.inject({
      url: `${url}/diff?${new URLSearchParams({ path, scope })}`,
    });
    const forIndex = await diff('staged.txt', 'index');
    assert.equal(forIndex.statusCode, 200, forIndex.body);
    assert.match(forIndex.json().patch, /-before[\s\S]*\+after/u);
    const forWorktree = await diff('staged.txt', 'worktree');
    assert.equal(forWorktree.statusCode, 200, forWorktree.body);
    assert.match(forWorktree.json().patch, /-after[\s\S]*\+working/u);
    const forUntracked = await diff('selected [literal].txt', 'worktree');
    assert.equal(forUntracked.statusCode, 200, forUntracked.body);
    assert.match(forUntracked.json().patch, /\+selected/u);

    const fetched = await app.inject({ method: 'POST', url: `${url}/fetch` });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json().upstream, 'origin/main');
    assert.deepEqual(fetched.json().remoteBranches, ['origin/feature/editor', 'origin/main']);

    const commit = await app.inject({
      method: 'POST', url: `${url}/commits`, payload: { message: 'Selected file', paths: ['selected [literal].txt'] },
    });
    assert.equal(commit.statusCode, 201, commit.body);
    assert.equal(git('show', '--format=', '--name-only', 'HEAD').trim(), 'selected [literal].txt');
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'staged.txt');
    const after = await app.inject({ url });
    const history = await app.inject({ url: `${url}/graph` });
    assert.equal(history.statusCode, 200, history.body);
    const [latest, initial] = history.json();
    assert.equal(latest.subject, 'Selected file');
    assert.equal(latest.email, 'test@example.invalid');
    const savedFiles = await app.inject({ url: `${url}/commits/${latest.oid}/files` });
    assert.equal(savedFiles.statusCode, 200, savedFiles.body);
    assert.deepEqual(savedFiles.json(), [
      { path: 'selected [literal].txt', status: 'A', additions: 1, deletions: 0 },
    ]);
    const savedDiff = await app.inject({ url: `${url}/commits/${latest.oid}/diff?${new URLSearchParams({ path: 'selected [literal].txt' })}` });
    assert.equal(savedDiff.statusCode, 200, savedDiff.body);
    assert.match(savedDiff.json().patch, /\+selected/u);
    assert.deepEqual(latest.parents, [initial.oid]);
    assert.ok(latest.refs.includes('HEAD -> main'));
    assert.equal(after.json().ahead, 1);
    assert.equal(after.json().behind, 0);

    // Stage, unstage, commit staged index only, discard worktree changes, and checkout branch.
    const unstageRes = await app.inject({
      method: 'POST', url: `${url}/unstage`, payload: { paths: ['staged.txt'] },
    });
    assert.equal(unstageRes.statusCode, 200, unstageRes.body);
    assert.deepEqual(unstageRes.json().changes, [
      { path: 'staged.txt', index: '.', workingTree: 'M' },
    ]);

    const stageRes = await app.inject({
      method: 'POST', url: `${url}/stage`, payload: { paths: ['staged.txt'] },
    });
    assert.equal(stageRes.statusCode, 200, stageRes.body);
    assert.deepEqual(stageRes.json().changes, [
      { path: 'staged.txt', index: 'M', workingTree: '.' },
    ]);

    // Modify worktree after staging so commit({ staged: true }) commits only staged index.
    writeFileSync(join(directory, 'staged.txt'), 'after-working');
    const stagedCommitRes = await app.inject({
      method: 'POST', url: `${url}/commits`, payload: { message: 'Staged only\n\nDetailed body line', staged: true },
    });
    assert.equal(stagedCommitRes.statusCode, 201, stagedCommitRes.body);
    assert.equal(git('show', 'HEAD:staged.txt'), 'working');

    const discardRes = await app.inject({
      method: 'POST', url: `${url}/discard`, payload: { paths: ['staged.txt'] },
    });
    assert.equal(discardRes.statusCode, 200, discardRes.body);
    assert.deepEqual(discardRes.json().changes, []);

    const historyWithBody = await app.inject({ url: `${url}/graph` });
    assert.equal(historyWithBody.statusCode, 200, historyWithBody.body);
    assert.equal(historyWithBody.json()[0].body, 'Detailed body line');

    const checkoutRes = await app.inject({
      method: 'POST', url: `${url}/checkout`, payload: { branch: 'feature/editor' },
    });
    assert.equal(checkoutRes.statusCode, 200, checkoutRes.body);
    assert.equal(checkoutRes.json().branch, 'feature/editor');
  } finally {
    await app.close();
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('project Git supports unstaging in an unborn repository before the first commit', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'matrius-git-unborn-'));
  const directory = join(temporary, 'project');
  mkdirSync(directory);
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: temporary, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);
  const { app } = await buildApp({ settings, db });

  try {
    execFileSync('git', ['-C', directory, 'init', '-b', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(directory, 'draft.txt'), 'hello');
    execFileSync('git', ['-C', directory, 'add', 'draft.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const project = await app.inject({
      method: 'POST', url: '/api/projects', payload: { hostId: 'local', directory },
    });
    const url = `/api/projects/${project.json().id}/git`;
    const unstaged = await app.inject({
      method: 'POST', url: `${url}/unstage`, payload: { paths: ['draft.txt'] },
    });
    assert.equal(unstaged.statusCode, 200, unstaged.body);
    assert.deepEqual(unstaged.json().changes, [
      { path: 'draft.txt', index: '?', workingTree: '?' },
    ]);
  } finally {
    await app.close();
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
