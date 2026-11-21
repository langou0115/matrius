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

  let wslState: 'Running' | 'Stopped' = 'Running';
  const commandCalls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  const hostFs = createHostFsService({
    db,
    wslCommand: 'wsl.exe',
    currentPlatform: 'linux',
    env: {},
    homeDir: browseRoot,
    async runCommand(command, args, opts) {
      commandCalls.push({ command, args, env: opts?.env });
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from(`  NAME            STATE           VERSION\r\n* Ubuntu-24.04    ${wslState}         2\r\n`, 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      if (command === 'wsl.exe' && args[0] === '-d') {
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

    // 2. WSL browse checks running status first and invokes wsl.exe -d only when Running.
    const wslRes = await app.inject({
      method: 'GET',
      url: `/api/hosts/${encodeURIComponent(wslHost.id)}/fs?path=${encodeURIComponent('~/workspace')}`,
    });
    assert.equal(wslRes.statusCode, 200);
    assert.equal(wslRes.json().path, '/home/ubuntu/workspace');
    const wslBrowseCall = commandCalls.find((call) => call.command === 'wsl.exe' && call.args[0] === '-d');
    assert.ok(wslBrowseCall);
    assert.equal(wslBrowseCall.args[1], 'Ubuntu-24.04');

    wslState = 'Stopped';
    const stoppedBeforeCount = commandCalls.filter((call) => call.command === 'wsl.exe' && call.args[0] === '-d').length;
    const wslStoppedRes = await app.inject({
      method: 'GET',
      url: `/api/hosts/${encodeURIComponent(wslHost.id)}/fs?path=${encodeURIComponent('~/workspace')}`,
    });
    assert.equal(wslStoppedRes.statusCode, 502);
    assert.equal(commandCalls.filter((call) => call.command === 'wsl.exe' && call.args[0] === '-d').length, stoppedBeforeCount);

    // 3. SSH password browse passes secret via SSH_ASKPASS env (never argv).
    const sshRes = await app.inject({
      method: 'GET',
      url: `/api/hosts/${encodeURIComponent(sshHost.id)}/fs?path=${encodeURIComponent('/srv/projects')}`,
    });
    assert.equal(sshRes.statusCode, 200);
    assert.equal(sshRes.json().path, '/srv/projects');
    const sshCall = commandCalls.find((call) => call.command === 'ssh');
    assert.ok(sshCall);
    assert.equal(sshCall.env?.MATRIUS_SSH_PASS, 'ssh-pass-123');
    assert.equal(sshCall.env?.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(sshCall.args.join(' ').includes('ssh-pass-123'), false);

    // 4. Create work project bound to WSL host + directory + per-CLI proxy URLs.
    const createdRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        hostId: wslHost.id,
        directory: '/home/ubuntu/workspace/repo',
        cliProxies: {
          codex: '127.0.0.1:7890',
          antigravity: 'socks5://127.0.0.1:1080',
          claude: 'http://127.0.0.1:8899',
        },
      },
    });
    assert.equal(createdRes.statusCode, 201);
    const project = createdRes.json();
    assert.equal(project.name, 'repo');
    assert.equal(project.hostId, wslHost.id);
    assert.equal(project.directory, '/home/ubuntu/workspace/repo');
    assert.deepEqual(project.cliProxies, {
      codex: 'http://127.0.0.1:7890',
      antigravity: 'socks5://127.0.0.1:1080',
      claude: 'http://127.0.0.1:8899',
    });

    const badProxyRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        hostId: wslHost.id,
        directory: '/home/ubuntu/workspace/repo',
        cliProxies: { codex: 'ftp://127.0.0.1:21' },
      },
    });
    assert.equal(badProxyRes.statusCode, 422);

    // 5. Reject unknown hostId on project creation.
    const badHostRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { hostId: 'missing-host', directory: '/tmp/foo' },
    });
    assert.equal(badHostRes.statusCode, 422);

    // 6. List, update (rejects name/host/directory edits, updates/clears cliProxies, enforces revision conflict), and delete work project.
    const listRes = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().items.length, 1);

    const lockedFieldPatch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: {
        name: 'matrius-renamed',
        cliProxies: {},
        baseRevision: project.revision,
      },
    });
    assert.equal(lockedFieldPatch.statusCode, 422);

    const lockedHostPatch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: {
        hostId: 'local',
        baseRevision: project.revision,
      },
    });
    assert.equal(lockedHostPatch.statusCode, 422);

    const lockedDirPatch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: {
        directory: '/tmp/other',
        baseRevision: project.revision,
      },
    });
    assert.equal(lockedDirPatch.statusCode, 422);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: {
        cliProxies: {},
        baseRevision: project.revision,
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const updated = patchRes.json();
    assert.equal(updated.name, 'repo');
    assert.equal(updated.hostId, wslHost.id);
    assert.equal(updated.directory, '/home/ubuntu/workspace/repo');
    assert.equal(updated.cliProxies, undefined);
    assert.equal(updated.revision, project.revision + 1);

    const stalePatchRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: {
        cliProxies: { codex: 'http://127.0.0.1:7890' },
        baseRevision: project.revision,
      },
    });
    assert.equal(stalePatchRes.statusCode, 409);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}?baseRevision=${updated.revision}`,
    });
    assert.equal(delRes.statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/projects' })).json().items, []);
  } finally {
    await app.close();
    db.close();
    if (process.getuid && process.getuid() !== 0) {
      chmodSync(lockedDir, 0o755);
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(browseRoot, { recursive: true, force: true });
  }
});

test('local filesystem browser exposes Windows drive selection via upward navigation and normalizes drive roots', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-roots-data-'));
  const browseRoot = mkdtempSync(join(tmpdir(), 'matrius-roots-fs-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  try {
    const winFs = createHostFsService({
      db,
      currentPlatform: 'win32',
      homeDir: browseRoot,
      listWindowsDrives: async () => ['C:\\', 'D:\\'],
    });
    const drivesView = await winFs.listEntries('local', '此电脑');
    assert.equal(drivesView.path, '此电脑');
    assert.equal(drivesView.parentPath, null);
    assert.equal(drivesView.selectable, false);
    assert.deepEqual(
      drivesView.entries.map((entry) => [entry.kind, entry.name, entry.path]),
      [
        ['directory', 'C:\\', 'C:\\'],
        ['directory', 'D:\\', 'D:\\'],
      ],
    );

    const slashDrives = await winFs.listEntries('local', '/');
    assert.equal(slashDrives.path, '此电脑');

    if (process.platform === 'win32') {
      const systemDrive = `${(process.env.SystemDrive ?? 'C:').replace(/\\$/u, '')}\\`;
      const driveRoot = await winFs.listEntries('local', systemDrive.slice(0, 2).toLowerCase());
      assert.equal(driveRoot.path.toUpperCase(), systemDrive.toUpperCase());
      assert.equal(driveRoot.parentPath, '此电脑');
    }
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(browseRoot, { recursive: true, force: true });
  }
});
