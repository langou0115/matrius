import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { openDatabase } from '../db/client';
import { migrate } from '../db/migrate';
import { createWorkHostService, parseWslListOutput } from '../services/hosts';

test('parseWslListOutput handles UTF-16LE and UTF-8 wsl.exe output', () => {
  const sample = [
    '  NAME              STATE           VERSION',
    '* Ubuntu-24.04      Running         2',
    '  docker-desktop    Stopped         2',
    '  Debian            Running         1',
  ].join('\r\n');

  const utf16 = Buffer.from(`\uFEFF${sample}`, 'utf16le');
  const parsed = parseWslListOutput(utf16);
  assert.deepEqual(parsed, [
    { name: 'Ubuntu-24.04', state: 'Running', version: 2, isDefault: true },
    { name: 'docker-desktop', state: 'Stopped', version: 2, isDefault: false },
    { name: 'Debian', state: 'Running', version: 1, isDefault: false },
  ]);

  assert.deepEqual(parseWslListOutput(sample), parsed);
});

test('hosts API persists SSH/WSL configs without exposing secrets and enforces baseRevision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-hosts-crud-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const calls: Array<{ command: string; args: string[] }> = [];
  const hosts = createWorkHostService({
    db,
    wslCommand: 'wsl.exe',
    async runCommand(command, args) {
      calls.push({ command, args });
      if (command === 'ssh') {
        return { code: 0, stdout: Buffer.from('matrius-ok'), stderr: Buffer.alloc(0) };
      }
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from('  NAME STATE VERSION\r\n* Ubuntu-24.04  Running  2\r\n', 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      if (command === 'wsl.exe' && args[0] === '-d') {
        return { code: 0, stdout: Buffer.from('matrius-ok'), stderr: Buffer.alloc(0) };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') };
    },
    async probeSshBanner(host, port) {
      return { ok: true, banner: `SSH-2.0-OpenSSH (${host}:${port})` };
    },
  });

  const { app } = await buildApp({ settings, db, hosts });
  try {
    const empty = await app.inject({ method: 'GET', url: '/api/hosts' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [] });

    // Create SSH password host with secret; secret must never be echoed back.
    const createdSsh = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      payload: {
        kind: 'ssh',
        name: '生产机器',
        host: '192.168.10.20',
        port: 2222,
        username: 'ops',
        authMethod: 'password',
        secret: 'super-secret-pass',
        defaultDirectory: '/srv/app',
      },
    });
    assert.equal(createdSsh.statusCode, 201);
    const sshBody = createdSsh.json<{ id: string; revision: number; hasSecret: boolean; status: string }>();
    assert.equal(sshBody.hasSecret, true);
    assert.equal(sshBody.status, 'disconnected');
    assert.equal(JSON.stringify(sshBody).includes('super-secret-pass'), false);

    // Editing without `secret` preserves stored secret; stale baseRevision returns 409.
    const updatedSsh = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${sshBody.id}`,
      payload: {
        baseRevision: sshBody.revision,
        kind: 'ssh',
        name: '生产机器-重命名',
        host: '192.168.10.20',
        port: 2222,
        username: 'ops',
        authMethod: 'password',
        defaultDirectory: '/srv/app',
      },
    });
    assert.equal(updatedSsh.statusCode, 200);
    assert.equal(updatedSsh.json<{ hasSecret: boolean; revision: number }>().hasSecret, true);
    assert.equal(updatedSsh.json<{ revision: number }>().revision, 2);

    const conflictRes = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${sshBody.id}`,
      payload: {
        baseRevision: 1,
        kind: 'ssh',
        name: 'stale',
        host: '192.168.10.20',
      },
    });
    assert.equal(conflictRes.statusCode, 409);

    // Connect SSH password host via banner probe -> connected.
    const connectedSsh = await app.inject({
      method: 'POST',
      url: `/api/hosts/${sshBody.id}/connect`,
    });
    assert.equal(connectedSsh.statusCode, 200);
    assert.equal(connectedSsh.json<{ status: string }>().status, 'connected');

    // Disconnect host -> disconnected.
    const disconnectedSsh = await app.inject({
      method: 'POST',
      url: `/api/hosts/${sshBody.id}/disconnect`,
    });
    assert.equal(disconnectedSsh.statusCode, 200);
    assert.equal(disconnectedSsh.json<{ status: string }>().status, 'disconnected');

    // Discover WSL distros and create + probe WSL host.
    const discovered = await app.inject({ method: 'GET', url: '/api/hosts/wsl/discover' });
    assert.equal(discovered.statusCode, 200);
    assert.equal(discovered.json<{ available: boolean; distros: unknown[] }>().available, true);
    assert.equal(discovered.json<{ distros: Array<{ name: string }> }>().distros[0]?.name, 'Ubuntu-24.04');

    const createdWsl = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      payload: {
        kind: 'wsl',
        name: 'Ubuntu 开发机',
        distro: 'Ubuntu-24.04',
        username: 'dev',
        defaultDirectory: '~/workspace',
      },
    });
    assert.equal(createdWsl.statusCode, 201);
    const wslId = createdWsl.json<{ id: string }>().id;

    const connectedWsl = await app.inject({
      method: 'POST',
      url: `/api/hosts/${wslId}/connect`,
    });
    assert.equal(connectedWsl.statusCode, 200);
    assert.equal(connectedWsl.json<{ status: string }>().status, 'connected');
    assert.ok(calls.some((call) => call.command === 'wsl.exe' && call.args.includes('Ubuntu-24.04')));

    // Reject option-like SSH hostnames to prevent argument injection.
    const badHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      payload: { kind: 'ssh', name: 'bad', host: '-oProxyCommand=evil' },
    });
    assert.equal(badHost.statusCode, 422);

    // Delete hosts.
    const deleted = await app.inject({ method: 'DELETE', url: `/api/hosts/${wslId}` });
    assert.equal(deleted.statusCode, 204);
    const listAfter = await app.inject({ method: 'GET', url: '/api/hosts' });
    assert.equal(listAfter.json<{ items: unknown[] }>().items.length, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hosts connect probes SSH key hosts with BatchMode and surfaces errors cleanly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-hosts-ssh-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  let mode: 'ok' | 'fail' = 'ok';
  const hosts = createWorkHostService({
    db,
    wslCommand: null,
    async runCommand(_command, args) {
      assert.ok(args.includes('BatchMode=yes'));
      assert.ok(args.includes('--'));
      if (mode === 'ok') return { code: 0, stdout: Buffer.from('matrius-ok'), stderr: Buffer.alloc(0) };
      return { code: 255, stdout: Buffer.alloc(0), stderr: Buffer.from('Permission denied (publickey).') };
    },
  });

  const { app } = await buildApp({ settings, db, hosts });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      payload: {
        kind: 'ssh',
        name: 'Build Box',
        host: 'build.internal',
        port: 22,
        username: 'ci',
        authMethod: 'key',
        privateKeyPath: '~/.ssh/id_ed25519',
      },
    });
    const hostId = created.json<{ id: string }>().id;

    const okRes = await app.inject({ method: 'POST', url: `/api/hosts/${hostId}/connect` });
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.json<{ status: string }>().status, 'connected');

    mode = 'fail';
    const failRes = await app.inject({ method: 'POST', url: `/api/hosts/${hostId}/connect` });
    assert.equal(failRes.statusCode, 200);
    assert.equal(failRes.json<{ status: string; statusMessage: string }>().status, 'error');
    assert.match(failRes.json<{ statusMessage: string }>().statusMessage, /Permission denied/);
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
