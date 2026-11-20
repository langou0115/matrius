import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { openDatabase } from '../db/client';
import { migrate } from '../db/migrate';
import { createWorkHostRow, serializeWorkHost } from '../db/repositories/hosts';
import { createHostFsService, parsePosixBrowseOutput } from '../services/host-fs';

test('parsePosixBrowseOutput parses directories before files, preserves access flags, and surfaces ERR messages', () => {
  const stdout = Buffer.from(
    'PWD\0/home/dev/work\0f1\0README.md\0d1\0src\0d0\0secret-dir\0d\0.git\0f0\0locked.txt\0',
    'utf8',
  );
  const parsed = parsePosixBrowseOutput('host-1', stdout);
  assert.equal(parsed.hostId, 'host-1');
  assert.equal(parsed.path, '/home/dev/work');
  assert.equal(parsed.parentPath, '/home/dev');
  assert.equal(parsed.truncated, false);
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.kind, entry.name, entry.path, entry.accessible]),
    [
      ['directory', '.git', '/home/dev/work/.git', true],
      ['directory', 'secret-dir', '/home/dev/work/secret-dir', false],
      ['directory', 'src', '/home/dev/work/src', true],
      ['file', 'locked.txt', '/home/dev/work/locked.txt', false],
      ['file', 'README.md', '/home/dev/work/README.md', true],
    ],
  );

  assert.throws(
    () => parsePosixBrowseOutput('host-1', Buffer.from('ERR\0无法访问目录：/missing\0', 'utf8')),
    /无法访问目录/,
  );
});

test('work projects CRUD and host filesystem browser support local, WSL and SSH hosts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-projects-data-'));
  const browseRoot = mkdtempSync(join(tmpdir(), 'matrius-projects-fs-'));
  const lockedDir = join(browseRoot, 'locked-dir');
  mkdirSync(join(browseRoot, 'alpha-dir'));
  mkdirSync(lockedDir);
  mkdirSync(join(browseRoot, 'zeta-dir'));
  writeFileSync(join(browseRoot, 'notes.md'), '# hello');
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(lockedDir, 0o000);
  }

  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const wslHostRow = createWorkHostRow(db, 1, {
    kind: 'wsl',
    name: 'Ubuntu-24.04',
    distro: 'Ubuntu-24.04',
  });
  const wslHost = serializeWorkHost(wslHostRow);
  const sshHostRow = createWorkHostRow(db, 1, {
    kind: 'ssh',
    name: 'Remote Box',
    host: '10.0.0.12',
    port: 22,
    username: 'dev',
    authMethod: 'password',
    secret: 'ssh-pass-123',
  });
  const sshHost = serializeWorkHost(sshHostRow);

  const commandCalls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  const hostFs = createHostFsService({
    db,
    wslCommand: 'wsl.exe',
    currentPlatform: 'linux',
    env: {},
    homeDir: browseRoot,
    async runCommand(command, args, opts) {
      commandCalls.push({ command, args, env: opts?.env });
      if (command === 'wsl.exe') {
        return {
          code: 0,
          stdout: Buffer.from('PWD\0/home/ubuntu/workspace\0d\0repo\0f\0todo.txt\0', 'utf8'),
          stderr: Buffer.alloc(0),
        };
      }
      if (command === 'ssh') {
        return {
          code: 0,
          stdout: Buffer.from('PWD\0/srv/projects\0d\0matrius\0f\0docker-compose.yml\0', 'utf8'),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') };
    },
  });

  const { app } = await buildApp({ settings, db, hostFs });
  try {
    // 1. Local host browse lists directories then files, marking unreadable entries as inaccessible.
    const localRes = await app.inject({ method: 'GET', url: '/api/hosts/local/fs' });
    assert.equal(localRes.statusCode, 200);
    const localBody = localRes.json();
    assert.equal(localBody.hostId, 'local');
    const expectLockedAccessible = process.getuid && process.getuid() !== 0 ? false : true;
    assert.deepEqual(
      localBody.entries.map((item: { kind: string; name: string; accessible: boolean }) => [item.kind, item.name, item.accessible]),
      [
        ['directory', 'alpha-dir', true],
        ['directory', 'locked-dir', expectLockedAccessible],
        ['directory', 'zeta-dir', true],
        ['file', 'notes.md', true],
      ],
    );
    if (!expectLockedAccessible) {
      const forbiddenRes = await app.inject({
        method: 'GET',
        url: `/api/hosts/local/fs?path=${encodeURIComponent(lockedDir)}`,
      });
      assert.equal(forbiddenRes.statusCode, 403);
    }

    // 2. WSL browse invokes wsl.exe with distro argument.
    const wslRes = await app.inject({
      method: 'GET',
      url: `/api/hosts/${encodeURIComponent(wslHost.id)}/fs?path=${encodeURIComponent('~/workspace')}`,
    });
    assert.equal(wslRes.statusCode, 200);
    assert.equal(wslRes.json().path, '/home/ubuntu/workspace');
    assert.equal(commandCalls[0].command, 'wsl.exe');
    assert.equal(commandCalls[0].args[1], 'Ubuntu-24.04');

    // 3. SSH password browse passes secret via SSH_ASKPASS env (never argv).
    const sshRes = await app.inject({
      method: 'GET',
      url: `/api/hosts/${encodeURIComponent(sshHost.id)}/fs?path=${encodeURIComponent('/srv/projects')}`,
    });
    assert.equal(sshRes.statusCode, 200);
    assert.equal(sshRes.json().path, '/srv/projects');
    assert.equal(commandCalls[1].command, 'ssh');
    assert.equal(commandCalls[1].env?.MATRIUS_SSH_PASS, 'ssh-pass-123');
    assert.equal(commandCalls[1].env?.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(commandCalls[1].args.join(' ').includes('ssh-pass-123'), false);

    // 4. Create work project bound to WSL host + directory.
    const createdRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        hostId: wslHost.id,
        directory: '/home/ubuntu/workspace/repo',
      },
    });
    assert.equal(createdRes.statusCode, 201);
    const project = createdRes.json();
    assert.equal(project.name, 'repo');
    assert.equal(project.hostId, wslHost.id);
    assert.equal(project.directory, '/home/ubuntu/workspace/repo');

    // 5. Reject unknown hostId on project creation.
    const badHostRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { hostId: 'missing-host', directory: '/tmp/foo' },
    });
    assert.equal(badHostRes.statusCode, 422);

    // 6. List and delete work project.
    const listRes = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().items.length, 1);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}?baseRevision=${project.revision}`,
    });
    assert.equal(delRes.statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/projects' })).json().items, []);
  } finally {
    await app.close();
    if (process.getuid && process.getuid() !== 0) {
      chmodSync(lockedDir, 0o755);
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(browseRoot, { recursive: true, force: true });
  }
});
