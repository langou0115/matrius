import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { openDatabase } from '../db/client';
import { migrate } from '../db/migrate';
import { createWorkHostRow, serializeWorkHost } from '../db/repositories/hosts';
import { createWorkProjectRow, serializeWorkProject } from '../db/repositories/projects';
import {
  createWorkTerminalService,
  mergeWindowsPathEntries,
  type PtyProcess,
  type PtySpawner,
} from '../services/terminals';

function createFakePty(): PtyProcess & {
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number) => void;
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
} {
  const emitter = new EventEmitter();
  const fake = {
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    killed: false,
    write(data: string) {
      fake.writes.push(data);
    },
    resize(cols: number, rows: number) {
      fake.resizes.push([cols, rows]);
    },
    kill() {
      fake.killed = true;
    },
    onData(listener: (data: string) => void) {
      emitter.on('data', listener);
      return { dispose: () => { emitter.off('data', listener); } };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      emitter.on('exit', listener);
      return { dispose: () => { emitter.off('exit', listener); } };
    },
    emitData(chunk: string) {
      emitter.emit('data', chunk);
    },
    emitExit(exitCode: number) {
      emitter.emit('exit', { exitCode });
    },
  };
  return fake;
}

test('work terminals API spawns PTY sessions for local/WSL/SSH projects, guards stopped WSL, and bridges WebSocket I/O', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-term-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'matrius-term-cwd-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const wslHost = serializeWorkHost(createWorkHostRow(db, 1, {
    kind: 'wsl',
    name: 'Ubuntu',
    distro: 'Ubuntu',
    username: 'dev',
  }));
  const sshHost = serializeWorkHost(createWorkHostRow(db, 1, {
    kind: 'ssh',
    name: 'Remote',
    host: '10.0.0.8',
    port: 2222,
    username: 'ops',
    authMethod: 'password',
    secret: 'ssh-secret-xyz',
  }));

  const localProject = serializeWorkProject(createWorkProjectRow(db, 1, { hostId: 'local', directory: workDir }));
  const wslProject = serializeWorkProject(createWorkProjectRow(db, 1, { hostId: wslHost.id, directory: '/home/dev/repo' }));
  const sshProject = serializeWorkProject(createWorkProjectRow(db, 1, { hostId: sshHost.id, directory: '/srv/app' }));

  let wslState: 'Running' | 'Stopped' = 'Running';
  const spawned: Array<{ file: string; args: string[]; cwd?: string; pty: ReturnType<typeof createFakePty> }> = [];
  const ptySpawn: PtySpawner = (file, args, opts) => {
    const pty = createFakePty();
    spawned.push({ file, args: Array.isArray(args) ? args : [args], cwd: opts.cwd, pty });
    return pty;
  };

  const terminals = createWorkTerminalService({
    db,
    ptySpawn,
    currentPlatform: 'win32',
    wslCommand: 'wsl.exe',
    async runCommand(command, args) {
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from(`  NAME      STATE       VERSION\r\n* Ubuntu    ${wslState}     2\r\n`, 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') };
    },
  });

  const { app } = await buildApp({ settings, db, terminals });
  try {
    // 1. Create a local Claude Code terminal session.
    const createLocal = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: {
        projectId: localProject.id,
        preset: 'claude',
        title: 'Claude Code',
        cols: 100,
        rows: 32,
      },
    });
    assert.equal(createLocal.statusCode, 201);
    const localSession = createLocal.json<{ id: string; title: string; preset: string; command: string; status: string }>();
    assert.equal(localSession.title, 'Claude Code');
    assert.equal(localSession.preset, 'claude');
    assert.equal(localSession.command, 'claude');
    assert.equal(spawned[0].file, 'powershell.exe');
    assert.equal(spawned[0].cwd, workDir);
    assert.ok(spawned[0].args.includes('claude'));

    // Buffer some output before WebSocket attaches, then stream live I/O via WebSocket.
    spawned[0].pty.emitData('booting...\r\n');
    const received: Array<{ type: string; data?: string; status?: string; exitCode?: number | null }> = [];
    const ws = await app.injectWS(
      `/api/work/terminals/${localSession.id}/ws`,
      {},
      {
        onInit(clientWs) {
          clientWs.on('message', (raw: unknown) => {
            received.push(JSON.parse(String(raw)));
          });
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(received.some((msg) => msg.type === 'snapshot' && msg.data === 'booting...\r\n'));
    assert.ok(received.some((msg) => msg.type === 'status' && msg.status === 'running'));

    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    spawned[0].pty.emitData('prompt> ');
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(spawned[0].pty.writes, ['ls\r']);
    assert.deepEqual(spawned[0].pty.resizes, [[120, 40]]);
    assert.ok(received.some((msg) => msg.type === 'output' && msg.data === 'prompt> '));

    spawned[0].pty.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(received.some((msg) => msg.type === 'status' && msg.status === 'exited' && msg.exitCode === 0));
    ws.close();

    // 2. Running WSL spawns PTY with wsl.exe; Stopped WSL is rejected without spawning PTY.
    const createWsl = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: wslProject.id, preset: 'shell' },
    });
    assert.equal(createWsl.statusCode, 201);
    assert.equal(spawned[1].file, 'wsl.exe');
    assert.ok(spawned[1].args.includes('Ubuntu'));

    wslState = 'Stopped';
    const spawnCountBeforeStopped = spawned.length;
    const createStoppedWsl = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: wslProject.id, preset: 'shell' },
    });
    assert.equal(createStoppedWsl.statusCode, 400);
    assert.equal(spawned.length, spawnCountBeforeStopped);

    // 3. SSH project spawns ssh -tt with remote directory cd.
    const createSsh = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: sshProject.id, preset: 'codex' },
    });
    assert.equal(createSsh.statusCode, 201);
    assert.equal(spawned[2].file, 'ssh');
    assert.ok(spawned[2].args.includes('-tt'));
    assert.ok(spawned[2].args.some((arg) => arg.includes('/srv/app') && arg.includes('codex')));

    // 4. Windows local CMD shell selection spawns cmd.exe and list exposes server platform.
    const createCmd = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: localProject.id, preset: 'shell', shell: 'cmd' },
    });
    assert.equal(createCmd.statusCode, 201);
    const cmdSession = createCmd.json<{ title: string; shell?: string }>();
    assert.equal(cmdSession.title, 'CMD');
    assert.equal(cmdSession.shell, 'cmd');
    assert.match(spawned[3].file, /cmd\.exe$/iu);

    // 5. Patch renames or pins session, and Delete terminates running PTY.
    const listed = await app.inject({ method: 'GET', url: '/api/work/terminals' });
    const listedPayload = listed.json<{ items: unknown[]; platform?: string }>();
    assert.equal(listedPayload.items.length, 4);
    assert.equal(listedPayload.platform, 'win32');

    const sshId = createSsh.json<{ id: string }>().id;
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/work/terminals/${sshId}`,
      payload: { title: '生产服务器', pinned: true },
    });
    assert.equal(patchRes.statusCode, 200);
    const patched = patchRes.json<{ title: string; pinned: boolean }>();
    assert.equal(patched.title, '生产服务器');
    assert.equal(patched.pinned, true);

    const delRes = await app.inject({ method: 'DELETE', url: `/api/work/terminals/${sshId}` });
    assert.equal(delRes.statusCode, 204);
    assert.equal(spawned[2].pty.killed, true);
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('persists terminal scrollback/cwd/meta and work_settings to SQLite across server restart including SSH/WSL unlock recovery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-term-persist-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'matrius-term-persist-cwd-'));
  const subDir = join(workDir, 'packages', 'ui');
  mkdirSync(subDir, { recursive: true });
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const dbPath = settings.databasePath;

  const firstDb = openDatabase(dbPath, { busyTimeoutMs: 1000 });
  migrate(firstDb);
  const wslHost = serializeWorkHost(createWorkHostRow(firstDb, 1, {
    kind: 'wsl',
    name: 'Ubuntu',
    distro: 'Ubuntu',
  }));
  const sshHost = serializeWorkHost(createWorkHostRow(firstDb, 1, {
    kind: 'ssh',
    name: 'Remote',
    host: '10.0.0.9',
    port: 22,
    username: 'ops',
    authMethod: 'password',
  }));
  const localProject = serializeWorkProject(createWorkProjectRow(firstDb, 1, { hostId: 'local', directory: workDir }));
  const wslProject = serializeWorkProject(createWorkProjectRow(firstDb, 1, { hostId: wslHost.id, directory: '/home/dev/app' }));
  const sshProject = serializeWorkProject(createWorkProjectRow(firstDb, 1, { hostId: sshHost.id, directory: '/srv/app' }));

  const spawned1: Array<{ file: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; pty: ReturnType<typeof createFakePty> }> = [];
  const ptySpawn1: PtySpawner = (file, args, opts) => {
    const pty = createFakePty();
    spawned1.push({ file, args: Array.isArray(args) ? args : [args], cwd: opts.cwd, env: opts.env, pty });
    return pty;
  };
  const firstTerminals = createWorkTerminalService({
    db: firstDb,
    ptySpawn: ptySpawn1,
    currentPlatform: 'win32',
    wslCommand: 'wsl.exe',
    async runCommand(command, args) {
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from('  NAME      STATE       VERSION\r\n* Ubuntu    Running     2\r\n', 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  let localId = '';
  let wslId = '';
  let sshId = '';
  const firstBuilt = await buildApp({ settings, db: firstDb, terminals: firstTerminals, migrate: false });
  try {
    const resLocal = await firstBuilt.app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: localProject.id, preset: 'shell', shell: 'cmd' },
    });
    assert.equal(resLocal.statusCode, 201);
    localId = resLocal.json<{ id: string }>().id;

    const resWsl = await firstBuilt.app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: wslProject.id, preset: 'shell' },
    });
    assert.equal(resWsl.statusCode, 201);
    wslId = resWsl.json<{ id: string }>().id;

    const resSsh = await firstBuilt.app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: sshProject.id, preset: 'shell' },
    });
    assert.equal(resSsh.statusCode, 201);
    sshId = resSsh.json<{ id: string }>().id;

    // Emit scrollback and CWD updates in each terminal, plus pin/rename one.
    spawned1[0].pty.emitData(`${subDir}>\r\n`);
    spawned1[1].pty.emitData('\x1b]7;file://localhost/home/dev/app/server\x07$ ');
    spawned1[2].pty.emitData('\x1b]7;file://localhost/srv/app/releases\x07ops$ ');
    await firstBuilt.app.inject({
      method: 'PATCH',
      url: `/api/work/terminals/${localId}`,
      payload: { title: 'UI构建终端', pinned: true },
    });
    await firstBuilt.app.inject({
      method: 'PUT',
      url: '/api/work/settings',
      payload: {
        defaultWindowsShell: 'cmd',
        activeProjectId: sshProject.id,
        activeTerminals: { [localProject.id]: localId, [sshProject.id]: sshId },
        filesPanelOpen: false,
        filesPanelWidth: 420,
      },
    });
  } finally {
    await firstBuilt.app.close();
    firstDb.close();
  }

  // Simulate full process restart opening the same SQLite database.
  const secondDb = openDatabase(dbPath, { busyTimeoutMs: 1000 });
  const spawned2: Array<{ file: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; pty: ReturnType<typeof createFakePty> }> = [];
  let secondWslState: 'Running' | 'Stopped' = 'Stopped';
  const runtimeHostSecrets = new Map<string, string>();
  const secondTerminals = createWorkTerminalService({
    db: secondDb,
    runtimeHostSecrets,
    ptySpawn: (file, args, opts) => {
      const pty = createFakePty();
      spawned2.push({ file, args: Array.isArray(args) ? args : [args], cwd: opts.cwd, env: opts.env, pty });
      return pty;
    },
    currentPlatform: 'win32',
    wslCommand: 'wsl.exe',
    async runCommand(command, args) {
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from(`  NAME      STATE       VERSION\r\n* Ubuntu    ${secondWslState}     2\r\n`, 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  const secondBuilt = await buildApp({ settings, db: secondDb, terminals: secondTerminals, migrate: false });
  try {
    // Saved work_settings and profile_fields remain isolated from Web tables.
    const settingsRes = await secondBuilt.app.inject({ method: 'GET', url: '/api/work/settings' });
    assert.equal(settingsRes.statusCode, 200);
    assert.deepEqual(settingsRes.json(), {
      defaultWindowsShell: 'cmd',
      activeProjectId: sshProject.id,
      activeTerminals: { [localProject.id]: localId, [sshProject.id]: sshId },
      filesPanelOpen: false,
      filesPanelWidth: 420,
    });
    const profileFieldsRes = await secondBuilt.app.inject({ method: 'GET', url: '/api/profile/fields' });
    assert.deepEqual(profileFieldsRes.json(), { items: [] });

    // Saved tabs wake in `restored` state with their persisted title, pin, shell, and last cwd.
    const listRes = await secondBuilt.app.inject({ method: 'GET', url: '/api/work/terminals' });
    const items = listRes.json<{ items: Array<{ id: string; title: string; pinned: boolean; shell?: string; cwd: string; status: string }> }>().items;
    assert.equal(items.length, 3);
    const savedLocal = items.find((item) => item.id === localId);
    const savedWsl = items.find((item) => item.id === wslId);
    const savedSsh = items.find((item) => item.id === sshId);
    assert.ok(savedLocal && savedWsl && savedSsh);
    assert.equal(savedLocal.title, 'UI构建终端');
    assert.equal(savedLocal.pinned, true);
    assert.equal(savedLocal.shell, 'cmd');
    assert.equal(savedLocal.cwd, subDir);
    assert.equal(savedLocal.status, 'restored');
    assert.equal(savedWsl.cwd, '/home/dev/app/server');
    assert.equal(savedSsh.cwd, '/srv/app/releases');

    // WebSocket snapshot still delivers previous scrollback before resuming.
    const snapMessages: Array<{ type: string; data?: string }> = [];
    const ws = await secondBuilt.app.injectWS(
      `/api/work/terminals/${localId}/ws`,
      {},
      {
        onInit(clientWs) {
          clientWs.on('message', (raw: unknown) => snapMessages.push(JSON.parse(String(raw))));
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(snapMessages.some((msg) => msg.type === 'snapshot' && msg.data?.includes('packages')));

    // Resuming local tab spawns cmd.exe straight into saved subdirectory.
    const resumeLocal = await secondBuilt.app.inject({
      method: 'POST',
      url: `/api/work/terminals/${localId}/resume`,
      payload: { cols: 110, rows: 34 },
    });
    assert.equal(resumeLocal.statusCode, 200);
    assert.equal(resumeLocal.json<{ status: string; cwd: string }>().status, 'running');
    assert.equal(spawned2[0].cwd, subDir);
    ws.close();

    // Stopped WSL fails resume cleanly while preserving saved state, then succeeds once WSL starts.
    const wslFail = await secondBuilt.app.inject({
      method: 'POST',
      url: `/api/work/terminals/${wslId}/resume`,
      payload: {},
    });
    assert.equal(wslFail.statusCode, 400);
    secondWslState = 'Running';
    const wslResume = await secondBuilt.app.inject({
      method: 'POST',
      url: `/api/work/terminals/${wslId}/resume`,
      payload: {},
    });
    assert.equal(wslResume.statusCode, 200);
    assert.ok(spawned2[1].args.some((arg) => arg.includes('/home/dev/app/server')));

    // Resuming SSH with entered password caches runtime secret (using SSH_ASKPASS) and cds back to /srv/app/releases.
    const sshResume = await secondBuilt.app.inject({
      method: 'POST',
      url: `/api/work/terminals/${sshId}/resume`,
      payload: { password: 'runtime-ssh-password', rememberPassword: false },
    });
    assert.equal(sshResume.statusCode, 200);
    assert.equal(spawned2[2].env?.MATRIUS_SSH_PASS, 'runtime-ssh-password');
    assert.ok(spawned2[2].args.some((arg) => arg.includes('/srv/app/releases')));
  } finally {
    await secondBuilt.app.close();
    secondDb.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('mergeWindowsPathEntries expands %VAR% registry paths and terminals receive project proxy env', async () => {
  const mergedPath = mergeWindowsPathEntries(
    'D:\\Software\\Nvm\\nodejs\\v26.12.0;C:\\WINDOWS\\system32',
    ['C:\\WINDOWS\\System32;%LOCALAPPDATA%\\agy\\bin;%USERPROFILE%\\.local\\bin'],
    { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local', USERPROFILE: 'C:\\Users\\demo' },
  );
  assert.equal(
    mergedPath,
    'D:\\Software\\Nvm\\nodejs\\v26.12.0;C:\\WINDOWS\\system32;C:\\Users\\demo\\AppData\\Local\\agy\\bin;C:\\Users\\demo\\.local\\bin',
  );

  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-term-proxy-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'matrius-term-proxy-cwd-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const sshHost = serializeWorkHost(createWorkHostRow(db, 1, {
    kind: 'ssh',
    name: 'ProxyBox',
    host: '10.0.0.15',
    authMethod: 'agent',
  }));
  const localProject = serializeWorkProject(createWorkProjectRow(db, 1, {
    hostId: 'local',
    directory: workDir,
    proxyUrl: 'http://127.0.0.1:7890',
  }));
  const sshProject = serializeWorkProject(createWorkProjectRow(db, 1, {
    hostId: sshHost.id,
    directory: '/srv/proxy-app',
    proxyUrl: 'socks5://127.0.0.1:1080',
  }));

  const spawned: Array<{ args: string[]; env?: Record<string, string | undefined>; pty: ReturnType<typeof createFakePty> }> = [];
  const terminals = createWorkTerminalService({
    db,
    currentPlatform: 'win32',
    env: { PATH: 'C:\\WINDOWS\\system32' },
    ptySpawn: (_file, args, opts) => {
      const pty = createFakePty();
      spawned.push({ args: Array.isArray(args) ? args : [args], env: opts.env, pty });
      return pty;
    },
  });
  const { app } = await buildApp({ settings, db, terminals });
  try {
    const localRes = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: localProject.id },
    });
    assert.equal(localRes.statusCode, 201);
    assert.equal(spawned[0].env?.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(spawned[0].env?.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(spawned[0].env?.ALL_PROXY, 'http://127.0.0.1:7890');

    const sshRes = await app.inject({
      method: 'POST',
      url: '/api/work/terminals',
      payload: { projectId: sshProject.id },
    });
    assert.equal(sshRes.statusCode, 201);
    assert.ok(spawned[1].args.some((arg) => arg.includes("HTTP_PROXY='socks5://127.0.0.1:1080'")));
    assert.ok(spawned[1].args.some((arg) => arg.includes("HTTPS_PROXY='socks5://127.0.0.1:1080'")));
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
