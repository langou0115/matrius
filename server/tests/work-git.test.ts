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
    const savedDiff = await app.inject({ url: `${url}/commits/${latest.oid}/diff` });
    assert.equal(savedDiff.statusCode, 200, savedDiff.body);
    assert.match(savedDiff.json().patch, /\+selected/u);
    assert.deepEqual(latest.parents, [initial.oid]);
    assert.ok(latest.refs.includes('HEAD -> main'));
    assert.equal(after.json().ahead, 1);
    assert.equal(after.json().behind, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
