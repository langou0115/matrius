import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildCliResumeCommand,
  claudeProjectSlug,
  fileUriToPath,
  formatCliTerminalTitle,
  normalizeCliSessionTitle,
  normalizeProjectDirectory,
  validateCliSessionId,
} from '../../contract/work-cli';
import { buildApp } from '../app';
import { loadSettings } from '../config';
import { openDatabase } from '../db/client';
import { migrate } from '../db/migrate';
import { createWorkHostRow, serializeWorkHost } from '../db/repositories/hosts';
import { createWorkProjectRow, serializeWorkProject } from '../db/repositories/projects';
import { createWorkCliSessionService } from '../services/cli-sessions';

test('pure work-cli helpers normalize paths, slugs, titles, and resume commands safely', () => {
  assert.equal(normalizeProjectDirectory('\\\\?\\D:\\Engineer\\matrius\\', 'win32'), 'd:\\engineer\\matrius');
  assert.equal(normalizeProjectDirectory('/home/dev/repo/', 'posix'), '/home/dev/repo');
  assert.equal(fileUriToPath('file:///D:/Engineer/matrius'), 'D:/Engineer/matrius');
  assert.equal(fileUriToPath('file:///home/dev/my%20app'), '/home/dev/my app');
  assert.equal(claudeProjectSlug('D:\\Engineer\\matrius'), 'D--Engineer-matrius');
  assert.equal(claudeProjectSlug('/home/dev/my.app'), '-home-dev-my-app');
  assert.equal(buildCliResumeCommand('claude', 'abc-123'), 'claude --resume abc-123');
  assert.equal(buildCliResumeCommand('codex', '01a1-thread'), 'codex resume 01a1-thread');
  assert.equal(buildCliResumeCommand('antigravity', '6b8f-conv'), 'agy --conversation 6b8f-conv');
  assert.throws(() => validateCliSessionId('bad;rm -rf /'), /不合法/);
  assert.equal(normalizeCliSessionTitle('<system-reminder>hi</system-reminder>  修复   bug\n列表', 'fallback'), '修复 bug 列表');
  assert.equal(formatCliTerminalTitle('x'.repeat(100), 'codex').length, 80);
});

test('cli-sessions service discovers Claude, Codex, and Antigravity sessions with running/completed detection and pagination', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-cli-data-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'matrius-cli-home-'));
  const projectDir = join(homeDir, 'workspace', 'matrius');
  mkdirSync(projectDir, { recursive: true });

  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const project = serializeWorkProject(createWorkProjectRow(db, 1, {
    hostId: 'local',
    directory: projectDir,
  }));
  const nowMs = 1_800_000_000_000;

  // 1. Seed Claude Code sessions (running via PID/tail, completed via turn_duration, stale idle, and sidechain).
  const claudeSlugDir = join(homeDir, '.claude', 'projects', claudeProjectSlug(projectDir));
  mkdirSync(claudeSlugDir, { recursive: true });
  mkdirSync(join(homeDir, '.claude', 'sessions'), { recursive: true });

  writeFileSync(
    join(homeDir, '.claude', 'sessions', '424242.json'),
    JSON.stringify({ pid: 424242, sessionId: 'claude-run-1', cwd: projectDir }),
  );
  writeFileSync(
    join(claudeSlugDir, 'claude-run-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '正在分析性能瓶颈' }, timestamp: new Date(nowMs - 5_000).toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [] }, timestamp: new Date(nowMs - 2_000).toISOString() }),
    ].join('\n') + '\n',
  );

  writeFileSync(
    join(claudeSlugDir, 'claude-done-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '初始提示词' }, timestamp: new Date(nowMs - 120_000).toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }, timestamp: new Date(nowMs - 90_000).toISOString() }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 3000, timestamp: new Date(nowMs - 90_000).toISOString() }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Claude 自定义标题' }),
    ].join('\n') + '\n',
  );

  const staleClaudeFile = join(claudeSlugDir, 'claude-stale-1.jsonl');
  writeFileSync(
    staleClaudeFile,
    JSON.stringify({ type: 'user', message: { role: 'user', content: '三天前中断的会话' }, timestamp: new Date(nowMs - 72 * 3600_000).toISOString() }) + '\n',
  );
  utimesSync(staleClaudeFile, new Date(nowMs - 72 * 3600_000), new Date(nowMs - 72 * 3600_000));

  writeFileSync(
    join(claudeSlugDir, 'agent-sub-1.jsonl'),
    JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent' } }) + '\n',
  );

  // 2. Seed Codex state_5.sqlite, thread_history_1.sqlite, and rollout JSONL files.
  const codexDir = join(homeDir, '.codex');
  const codexRolloutDir = join(codexDir, 'sessions', '2026', '11', '21');
  mkdirSync(codexRolloutDir, { recursive: true });

  const codexRunningRollout = join(codexRolloutDir, 'rollout-running.jsonl');
  writeFileSync(
    codexRunningRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-run-1', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n') + '\n',
  );
  const codexDoneRollout = join(codexRolloutDir, 'rollout-done.jsonl');
  writeFileSync(
    codexDoneRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-done-1', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n',
  );

  const stateDb = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '',
      name TEXT, attached_thread_parent_id TEXT
    );
  `);
  const insertThread = stateDb.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, first_user_message, updated_at_ms, preview, name, attached_thread_parent_id)
     VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, '{}', 'on-request', ?, ?, ?, '', ?, ?)`,
  );
  const storedCwd = process.platform === 'win32' ? `\\\\?\\${projectDir}` : projectDir;
  insertThread.run('codex-run-1', codexRunningRollout, 1799999, 1799999, 'cli', storedCwd, 'Codex 运行中任务', 0, 'Codex 运行中任务', nowMs - 3_000, 'Codex 运行中任务', null);
  insertThread.run('codex-done-1', codexDoneRollout, 1799990, 1799990, 'vscode', storedCwd, 'Codex 已完成任务', 0, 'Codex 已完成任务', nowMs - 40_000, null, null);
  insertThread.run('codex-guardian-1', codexDoneRollout, 1799995, 1799995, '{"subagent":{"other":"guardian"}}', storedCwd, 'Guardian review', 0, '', nowMs - 20_000, 'Guardian review', null);
  insertThread.run('codex-other-proj', codexDoneRollout, 1799995, 1799995, 'cli', join(homeDir, 'other-repo'), '其他项目会话', 0, '其他项目会话', nowMs - 10_000, null, null);
  stateDb.close();

  const histDb = new DatabaseSync(join(codexDir, 'thread_history_1.sqlite'));
  histDb.exec('CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id))');
  histDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('codex-run-1', 'turn-1', 10, 'inProgress');
  histDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('codex-done-1', 'turn-1', 10, 'completed');
  histDb.close();

  // 3. Seed Antigravity conversation_summaries.db.
  const agyDir = join(homeDir, '.gemini', 'antigravity-cli');
  mkdirSync(join(agyDir, 'conversations'), { recursive: true });
  const sumDb = new DatabaseSync(join(agyDir, 'conversation_summaries.db'));
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0, last_modified_time TEXT NOT NULL, workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "", parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0, killed INTEGER NOT NULL DEFAULT 0,
      last_user_input_time TEXT NOT NULL
    );
  `);
  const uriPath = projectDir.replaceAll('\\', '/');
  const workspaceUri = uriPath.startsWith('/') ? `file://${uriPath}` : `file:///${uriPath}`;
  const insertSummary = sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertSummary.run('agy-run-1', 'Antigravity 运行中', '', 5, new Date(nowMs - 1_000).toISOString(), JSON.stringify([workspaceUri]), 'CASCADE_RUN_STATUS_RUNNING', '', 0, 0, new Date(nowMs - 2_000).toISOString());
  insertSummary.run('agy-done-1', 'Antigravity 已完成', '', 12, new Date(nowMs - 60_000).toISOString(), JSON.stringify([workspaceUri]), 'CASCADE_RUN_STATUS_IDLE', '', 0, 0, new Date(nowMs - 70_000).toISOString());
  insertSummary.run('agy-sub-1', 'Subagent Child', '', 3, new Date(nowMs - 500).toISOString(), JSON.stringify([workspaceUri]), 'CASCADE_RUN_STATUS_RUNNING', 'agy-run-1', 1, 0, new Date(nowMs - 500).toISOString());
  sumDb.close();

  const cliSessions = createWorkCliSessionService({
    db,
    homeDir,
    currentPlatform: process.platform,
    now: () => nowMs,
    isPidAlive: (pid) => pid === 424242,
  });

  const { app } = await buildApp({ settings, db, cliSessions });
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/cli-sessions?limit=4`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      projectId: string;
      total: number;
      hasMore: boolean;
      items: Array<{ id: string; provider: string; title: string; status: string }>;
    }>();
    assert.equal(body.projectId, project.id);
    assert.equal(body.total, 7);
    assert.equal(body.hasMore, true);
    assert.equal(body.items.length, 4);

    // Top 4 sorted by updatedAt DESC, and limit=20 returns all 7 sessions.
    const fullRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/cli-sessions?limit=20`,
    });
    const full = fullRes.json<{ items: Array<{ id: string; provider: string; title: string; status: string }>; total: number; hasMore: boolean }>();
    assert.equal(full.total, 7);
    assert.equal(full.hasMore, false);

    const byId = new Map(full.items.map((item) => [item.id, item]));
    assert.equal(byId.get('agy-run-1')?.status, 'running');
    assert.equal(byId.get('agy-done-1')?.status, 'completed');
    assert.equal(byId.get('claude-run-1')?.status, 'running');
    assert.equal(byId.get('claude-done-1')?.status, 'completed');
    assert.equal(byId.get('claude-done-1')?.title, 'Claude 自定义标题');
    assert.equal(byId.get('claude-stale-1')?.status, 'idle');
    assert.equal(byId.get('codex-run-1')?.status, 'running');
    assert.equal(byId.get('codex-done-1')?.status, 'completed');
    assert.equal(byId.has('codex-guardian-1'), false);
    assert.equal(byId.has('agy-sub-1'), false);
    assert.equal(byId.has('agent-sub-1'), false);
    assert.equal(byId.has('codex-other-proj'), false);
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('cli-sessions service queries WSL and SSH hosts safely via python3 probe', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-cli-remote-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);

  const wslHost = serializeWorkHost(createWorkHostRow(db, 1, { kind: 'wsl', name: 'Ubuntu', distro: 'Ubuntu' }));
  const sshHost = serializeWorkHost(createWorkHostRow(db, 1, { kind: 'ssh', name: 'Prod', host: '10.0.0.2', authMethod: 'password' }));
  const wslProject = serializeWorkProject(createWorkProjectRow(db, 1, { hostId: wslHost.id, directory: '/home/dev/app' }));
  const sshProject = serializeWorkProject(createWorkProjectRow(db, 1, { hostId: sshHost.id, directory: '/srv/app' }));

  let wslState: 'Running' | 'Stopped' = 'Running';
  const runtimeHostSecrets = new Map<string, string>();
  const cliSessions = createWorkCliSessionService({
    db,
    currentPlatform: 'win32',
    wslCommand: 'wsl.exe',
    runtimeHostSecrets,
    async runCommand(command, args) {
      if (command === 'wsl.exe' && args[0] === '-l') {
        return {
          code: 0,
          stdout: Buffer.from(`  NAME      STATE       VERSION\r\n* Ubuntu    ${wslState}     2\r\n`, 'utf16le'),
          stderr: Buffer.alloc(0),
        };
      }
      if (command === 'wsl.exe' && args[0] === '-d') {
        return {
          code: 0,
          stdout: Buffer.from(JSON.stringify({
            items: [{ id: 'wsl-claude-1', provider: 'claude', title: 'WSL Claude 任务', status: 'completed', updatedAt: 1795000000000 }],
            total: 1,
            hasMore: false,
          })),
          stderr: Buffer.alloc(0),
        };
      }
      if (command === 'ssh') {
        return {
          code: 0,
          stdout: Buffer.from(JSON.stringify({
            items: [{ id: 'ssh-codex-1', provider: 'codex', title: 'SSH Codex 部署', status: 'running', updatedAt: 1795000010000 }],
            total: 1,
            hasMore: false,
          })),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  const { app } = await buildApp({ settings, db, cliSessions });
  try {
    const wslRes = await app.inject({ method: 'GET', url: `/api/projects/${wslProject.id}/cli-sessions` });
    assert.equal(wslRes.statusCode, 200);
    assert.equal(wslRes.json().items[0].id, 'wsl-claude-1');

    wslState = 'Stopped';
    const stoppedRes = await app.inject({ method: 'GET', url: `/api/projects/${wslProject.id}/cli-sessions` });
    assert.equal(stoppedRes.statusCode, 502);

    const lockedSshRes = await app.inject({ method: 'GET', url: `/api/projects/${sshProject.id}/cli-sessions` });
    assert.equal(lockedSshRes.statusCode, 401);

    runtimeHostSecrets.set(sshHost.id, 'ssh-secret');
    const unlockedSshRes = await app.inject({ method: 'GET', url: `/api/projects/${sshProject.id}/cli-sessions` });
    assert.equal(unlockedSshRes.statusCode, 200);
    assert.equal(unlockedSshRes.json().items[0].status, 'running');
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('extracts Claude ai-title and Codex rollout user_message / session_index fallback titles cleanly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-cli-titles-data-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'matrius-cli-titles-home-'));
  const projectDir = join(homeDir, 'workspace', 'titles-demo');
  mkdirSync(projectDir, { recursive: true });

  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);
  const project = serializeWorkProject(createWorkProjectRow(db, 1, {
    hostId: 'local',
    directory: projectDir,
  }));
  const nowMs = 1_800_000_000_000;

  const claudeSlugDir = join(homeDir, '.claude', 'projects', claudeProjectSlug(projectDir));
  mkdirSync(claudeSlugDir, { recursive: true });
  writeFileSync(
    join(claudeSlugDir, 'claude-ai-title-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '初始提示词应该被 AI 标题覆盖' }, timestamp: new Date(nowMs - 8_000).toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }, timestamp: new Date(nowMs - 4_000).toISOString() }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200, timestamp: new Date(nowMs - 4_000).toISOString() }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Claude 自动标题' }),
    ].join('\n') + '\n',
  );

  const codexDir = join(homeDir, '.codex');
  const rolloutDir = join(codexDir, 'sessions', '2026', '11', '22');
  mkdirSync(rolloutDir, { recursive: true });
  const rolloutFromPrompt = join(rolloutDir, 'rollout-prompt.jsonl');
  writeFileSync(
    rolloutFromPrompt,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-rollout-prompt', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '来自 rollout 的首句标题' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n',
  );
  const rolloutIndexed = join(rolloutDir, 'rollout-indexed.jsonl');
  writeFileSync(
    rolloutIndexed,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-indexed-1', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '旧首句' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(codexDir, 'session_index.jsonl'),
    JSON.stringify({ id: 'codex-indexed-1', thread_name: '索引最新线程名' }) + '\n',
  );

  const stateDb = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '',
      name TEXT, attached_thread_parent_id TEXT
    );
  `);
  const insertThread = stateDb.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, first_user_message, updated_at_ms, preview, name, attached_thread_parent_id)
     VALUES (?, ?, ?, ?, 'cli', 'openai', ?, '', '{}', 'on-request', 0, '', ?, '', NULL, NULL)`,
  );
  insertThread.run('codex-rollout-prompt', rolloutFromPrompt, 1799998, 1799998, projectDir, nowMs - 2_000);
  insertThread.run('codex-indexed-1', rolloutIndexed, 1799999, 1799999, projectDir, nowMs - 1_000);
  stateDb.close();

  const cliSessions = createWorkCliSessionService({
    db,
    homeDir,
    currentPlatform: process.platform,
    now: () => nowMs,
  });
  const { app } = await buildApp({ settings, db, cliSessions });
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/cli-sessions?limit=20`,
    });
    assert.equal(res.statusCode, 200);
    const byId = new Map(
      res.json<{ items: Array<{ id: string; title: string; status: string }> }>().items.map((item) => [item.id, item]),
    );
    assert.equal(byId.get('claude-ai-title-1')?.title, 'Claude 自动标题');
    assert.equal(byId.get('claude-ai-title-1')?.status, 'completed');
    assert.equal(byId.get('codex-rollout-prompt')?.title, '来自 rollout 的首句标题');
    assert.equal(byId.get('codex-indexed-1')?.title, '索引最新线程名');
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('cli-sessions accurately classifies interrupted, large-tail, stale-inProgress, and finished Antigravity sessions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-cli-accuracy-data-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'matrius-cli-accuracy-home-'));
  const projectDir = join(homeDir, 'workspace', 'accuracy-demo');
  mkdirSync(projectDir, { recursive: true });

  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent' });
  const db = openDatabase(settings.databasePath, { busyTimeoutMs: 1000 });
  migrate(db);
  const project = serializeWorkProject(createWorkProjectRow(db, 1, {
    hostId: 'local',
    directory: projectDir,
  }));
  const nowMs = 1_800_000_000_000;

  const claudeSlugDir = join(homeDir, '.claude', 'projects', claudeProjectSlug(projectDir));
  mkdirSync(claudeSlugDir, { recursive: true });
  mkdirSync(join(homeDir, '.claude', 'sessions'), { recursive: true });

  // Live PIDs for interrupted & waiting sessions.
  writeFileSync(
    join(homeDir, '.claude', 'sessions', '10101.json'),
    JSON.stringify({ pid: 10101, sessionId: 'claude-interrupted-1', status: 'busy', cwd: projectDir }),
  );
  writeFileSync(
    join(homeDir, '.claude', 'sessions', '10102.json'),
    JSON.stringify({ pid: 10102, sessionId: 'claude-empty-prompt-1', status: 'idle', cwd: projectDir }),
  );

  // 1. User interrupted turn even though PID stays alive -> idle (not stuck running).
  writeFileSync(
    join(claudeSlugDir, 'claude-interrupted-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '执行重构' }, timestamp: new Date(nowMs - 4_000).toISOString() }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: new Date(nowMs - 1_000).toISOString() }),
    ].join('\n') + '\n',
  );

  // 2. Live idle zero-turn prompt -> idle (not spinning).
  writeFileSync(
    join(claudeSlugDir, 'claude-empty-prompt-1.jsonl'),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'snap-1' }) + '\n',
  );

  // 3. Large >40KB single JSONL record after turn_duration / trailing last-prompt & stop_hook_summary -> adaptive tail finds completed.
  writeFileSync(
    join(claudeSlugDir, 'claude-large-tail-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '读取超大日志并完成' }, timestamp: new Date(nowMs - 20_000).toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(42_000) }] }, timestamp: new Date(nowMs - 10_000).toISOString() }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 2500, timestamp: new Date(nowMs - 10_000).toISOString() }),
      JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, timestamp: new Date(nowMs - 9_500).toISOString() }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '读取超大日志并完成' }),
    ].join('\n') + '\n',
  );

  // 4. Codex session with stale inProgress (> 3 min old) -> idle instead of stuck forever.
  const codexDir = join(homeDir, '.codex');
  const rolloutDir = join(codexDir, 'sessions', '2026', '11', '23');
  mkdirSync(rolloutDir, { recursive: true });
  const staleCodexRollout = join(rolloutDir, 'rollout-stale.jsonl');
  writeFileSync(
    staleCodexRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-stale-inprog', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '旧卡死任务' }, timestamp: new Date(nowMs - 400_000).toISOString() }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(nowMs - 390_000).toISOString() }),
    ].join('\n') + '\n',
  );
  utimesSync(staleCodexRollout, new Date(nowMs - 390_000), new Date(nowMs - 390_000));

  const largeCodexRollout = join(rolloutDir, 'rollout-large.jsonl');
  writeFileSync(
    largeCodexRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-large-done', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '超大输出已完成' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'd'.repeat(42_000) } }),
    ].join('\n') + '\n',
  );

  const stateDb = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '',
      name TEXT, attached_thread_parent_id TEXT
    );
  `);
  const insertThread = stateDb.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, first_user_message, updated_at_ms, preview, name, attached_thread_parent_id)
     VALUES (?, ?, ?, ?, 'cli', 'openai', ?, '', '{}', 'on-request', 0, '', ?, '', NULL, NULL)`,
  );
  insertThread.run('codex-stale-inprog', staleCodexRollout, 1799600, 1799600, projectDir, nowMs - 390_000);
  insertThread.run('codex-large-done', largeCodexRollout, 1799990, 1799990, projectDir, nowMs - 10_000);
  stateDb.close();

  const histDb = new DatabaseSync(join(codexDir, 'thread_history_1.sqlite'));
  histDb.exec('CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id))');
  histDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('codex-stale-inprog', 'turn-1', 10, 'inProgress');
  histDb.close();

  // 5. Antigravity summary says RUNNING, but conversation DB steps are already all completed >15s ago -> completed.
  const agyDir = join(homeDir, '.gemini', 'antigravity-cli');
  mkdirSync(join(agyDir, 'conversations'), { recursive: true });
  const sumDb = new DatabaseSync(join(agyDir, 'conversation_summaries.db'));
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0, last_modified_time TEXT NOT NULL, workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "", parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0, killed INTEGER NOT NULL DEFAULT 0,
      last_user_input_time TEXT NOT NULL
    );
  `);
  const uriPath = projectDir.replaceAll('\\', '/');
  const workspaceUri = uriPath.startsWith('/') ? `file://${uriPath}` : `file:///${uriPath}`;
  sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agy-finished-lag-1', '已结束但摘要滞后', '', 4, new Date(nowMs - 25_000).toISOString(), JSON.stringify([workspaceUri]), 'CASCADE_RUN_STATUS_RUNNING', '', 0, 0, new Date(nowMs - 30_000).toISOString());
  sumDb.close();

  const convDbPath = join(agyDir, 'conversations', 'agy-finished-lag-1.db');
  const convDb = new DatabaseSync(convDbPath);
  convDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER NOT NULL)');
  convDb.prepare('INSERT INTO steps VALUES (?, ?)').run(1, 3);
  convDb.prepare('INSERT INTO steps VALUES (?, ?)').run(2, 3);
  convDb.close();
  utimesSync(convDbPath, new Date(nowMs - 25_000), new Date(nowMs - 25_000));

  const cliSessions = createWorkCliSessionService({
    db,
    homeDir,
    currentPlatform: process.platform,
    now: () => nowMs,
    isPidAlive: (pid) => pid === 10101 || pid === 10102,
  });
  const { app } = await buildApp({ settings, db, cliSessions });
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/cli-sessions?limit=20`,
    });
    assert.equal(res.statusCode, 200);
    const byId = new Map(
      res.json<{ items: Array<{ id: string; status: string }> }>().items.map((item) => [item.id, item]),
    );
    assert.equal(byId.get('claude-interrupted-1')?.status, 'idle');
    assert.equal(byId.get('claude-empty-prompt-1')?.status, 'idle');
    assert.equal(byId.get('claude-large-tail-1')?.status, 'completed');
    assert.equal(byId.get('codex-stale-inprog')?.status, 'idle');
    assert.equal(byId.get('codex-large-done')?.status, 'completed');
    assert.equal(byId.get('agy-finished-lag-1')?.status, 'completed');
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
