import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  claudeProjectSlug,
  fileUriToPath,
  isValidCliSessionId,
  normalizeCliSessionTitle,
  normalizeProjectDirectory,
  parseIsoTimestampMs,
  stripWindowsExtendedPathPrefix,
  type WorkCliProvider,
  type WorkCliSession,
  type WorkCliSessionStatus,
  type WorkProjectCliSessionsResponse,
} from '../../contract/work-cli';
import { LOCAL_WORK_HOST_ID } from '../../contract/work-projects';
import type { AppDatabase } from '../db/client';
import { fromDbUuid } from '../db/codecs';
import { requireWorkHostRow, type WorkHostRow } from '../db/repositories/hosts';
import { requireWorkProjectRow, serializeWorkProject } from '../db/repositories/projects';
import { AppError } from '../errors';
import { ensureAskpassScript, posixSingleQuote } from './host-fs';
import {
  decodeWslText,
  defaultRunCommand,
  ensureWslDistroRunning,
  expandHomePath,
  resolveWslCommand,
  type HostCommandRunner,
} from './hosts';

const INSTANCE_ID = 1;
const HEAD_READ_BYTES = 16 * 1024;
const TAIL_READ_BYTES = 32 * 1024;
const RUNNING_STALE_MS = 30 * 60 * 1000;
const REMOTE_CLI_TIMEOUT_MS = 10_000;
const MAX_FETCH_LIMIT = 200;

export type WorkCliSessionService = {
  listByProject(projectId: string, options?: { limit?: number }): Promise<WorkProjectCliSessionsResponse>;
};

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'EPERM';
  }
}

function clampFetchLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
  return Math.max(1, Math.min(MAX_FETCH_LIMIT, Math.floor(raw)));
}

async function readHeadAndTail(
  filePath: string,
  headBytes = HEAD_READ_BYTES,
  tailBytes = TAIL_READ_BYTES,
): Promise<{ head: string; tail: string; mtimeMs: number; size: number } | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    const size = info.size;
    if (size === 0) {
      return { head: '', tail: '', mtimeMs: info.mtimeMs, size: 0 };
    }
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      return { head: text, tail: text, mtimeMs: info.mtimeMs, size };
    }

    const headBuf = Buffer.allocUnsafe(headBytes);
    const headRes = await handle.read(headBuf, 0, headBytes, 0);
    const head = headBuf.subarray(0, headRes.bytesRead).toString('utf8');

    const tailOffset = Math.max(0, size - tailBytes);
    const tailLen = size - tailOffset;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    const tailRes = await handle.read(tailBuf, 0, tailLen, tailOffset);
    let tail = tailBuf.subarray(0, tailRes.bytesRead).toString('utf8');
    if (tailOffset > 0) {
      const firstNewline = tail.indexOf('\n');
      tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : '';
    }
    return { head, tail, mtimeMs: info.mtimeMs, size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore partial boundary lines.
    }
  }
  return out;
}

function extractTextFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push(rec.text);
    }
  }
  return parts.join(' ');
}

function isIgnorableClaudeUserPrompt(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^<(?:local-command-caveat|local-command-stdout|command-name|command-message|system-reminder)\b/iu.test(trimmed)) {
    return true;
  }
  return false;
}

type ClaudeIndexEntry = {
  sessionId?: string;
  fullPath?: string;
  firstPrompt?: string;
  summary?: string;
  customTitle?: string;
  modified?: string;
  projectPath?: string;
  isSidechain?: boolean;
};

async function readLocalClaudeSessions(options: {
  claudeDir: string;
  projectId: string;
  projectDir: string;
  platformHint: 'win32' | 'posix';
  nowMs: number;
  isPidAlive: (pid: number) => boolean;
}): Promise<WorkCliSession[]> {
  const { claudeDir, projectId, projectDir, platformHint, nowMs, isPidAlive } = options;
  const projectsRoot = join(claudeDir, 'projects');
  if (!existsSync(projectsRoot)) return [];

  const activeSessionIds = new Set<string>();
  const sessionsMetaDir = join(claudeDir, 'sessions');
  if (existsSync(sessionsMetaDir)) {
    try {
      const metaFiles = await readdir(sessionsMetaDir, { withFileTypes: true });
      for (const entry of metaFiles) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await readFile(join(sessionsMetaDir, entry.name), 'utf8')) as {
            pid?: unknown;
            sessionId?: unknown;
          };
          if (
            typeof parsed.pid === 'number'
            && isPidAlive(parsed.pid)
            && typeof parsed.sessionId === 'string'
            && isValidCliSessionId(parsed.sessionId)
          ) {
            activeSessionIds.add(parsed.sessionId);
          }
        } catch {
          // Ignore malformed PID tracking files.
        }
      }
    } catch {
      // Ignore unreadable sessions dir.
    }
  }

  const normalizedTarget = normalizeProjectDirectory(projectDir, platformHint);
  const expectedSlug = claudeProjectSlug(projectDir);
  const expectedSlugLower = expectedSlug.toLowerCase();

  let projectFolders: string[] = [];
  try {
    const dirs = await readdir(projectsRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const slugMatches = platformHint === 'win32'
        ? dir.name.toLowerCase() === expectedSlugLower
        : dir.name === expectedSlug;
      if (slugMatches) {
        projectFolders.push(join(projectsRoot, dir.name));
        continue;
      }
      // Also inspect `sessions-index.json` in case Claude sanitized punctuation differently.
      const indexPath = join(projectsRoot, dir.name, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const rawIdx = JSON.parse(await readFile(indexPath, 'utf8')) as {
            originalPath?: string;
            entries?: ClaudeIndexEntry[];
          };
          const candidatePath = rawIdx.originalPath || rawIdx.entries?.[0]?.projectPath;
          if (candidatePath && normalizeProjectDirectory(candidatePath, platformHint) === normalizedTarget) {
            projectFolders.push(join(projectsRoot, dir.name));
          }
        } catch {
          // Ignore unreadable index.
        }
      }
    }
  } catch {
    return [];
  }

  projectFolders = [...new Set(projectFolders)];
  if (projectFolders.length === 0) return [];

  const results = new Map<string, WorkCliSession>();

  for (const folder of projectFolders) {
    const indexBySession = new Map<string, ClaudeIndexEntry>();
    const indexPath = join(folder, 'sessions-index.json');
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as { entries?: ClaudeIndexEntry[] };
        for (const entry of parsed.entries ?? []) {
          if (entry.sessionId && isValidCliSessionId(entry.sessionId)) {
            indexBySession.set(entry.sessionId, entry);
          }
        }
      } catch {
        // Ignore broken index; fall back to JSONL files directly.
      }
    }

    let files;
    try {
      files = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name.startsWith('agent-')) continue;
      const sessionId = file.name.slice(0, -6);
      if (!isValidCliSessionId(sessionId)) continue;

      const idxMeta = indexBySession.get(sessionId);
      if (idxMeta?.isSidechain) continue;

      const slices = await readHeadAndTail(join(folder, file.name));
      if (!slices) continue;

      const headLines = parseJsonLines(slices.head);
      const tailLines = slices.tail === slices.head ? headLines : parseJsonLines(slices.tail);

      if (headLines.some((item) => item.isSidechain === true)) continue;

      let customTitle: string | undefined = idxMeta?.customTitle;
      let aiTitle: string | undefined;
      let summaryTitle: string | undefined = idxMeta?.summary;
      let firstUserPrompt: string | undefined = idxMeta?.firstPrompt;
      let hasConversationTurn = false;

      for (const rec of headLines) {
        if (rec.type === 'user' || rec.type === 'assistant') hasConversationTurn = true;
        if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
          customTitle = rec.customTitle;
        } else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
          aiTitle = rec.aiTitle;
        } else if (rec.type === 'summary' && typeof rec.summary === 'string') {
          summaryTitle = rec.summary;
        } else if (rec.type === 'user' && !rec.isMeta && !firstUserPrompt) {
          const msg = rec.message as { content?: unknown } | undefined;
          const text = extractTextFromClaudeContent(msg?.content);
          if (!isIgnorableClaudeUserPrompt(text)) {
            firstUserPrompt = text;
          }
        }
      }

      let latestTs = slices.mtimeMs;
      for (const rec of tailLines) {
        if (rec.type === 'user' || rec.type === 'assistant') hasConversationTurn = true;
        if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
          customTitle = rec.customTitle;
        } else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
          aiTitle = rec.aiTitle;
        } else if (rec.type === 'summary' && typeof rec.summary === 'string') {
          summaryTitle = rec.summary;
        }
        if (typeof rec.timestamp === 'string') {
          const parsedTs = parseIsoTimestampMs(rec.timestamp);
          if (parsedTs > latestTs) latestTs = parsedTs;
        }
      }

      if (!hasConversationTurn && !customTitle && !aiTitle && !summaryTitle && !activeSessionIds.has(sessionId)) {
        continue;
      }

      const isActive = activeSessionIds.has(sessionId);
      const isFresh = nowMs - latestTs < RUNNING_STALE_MS;
      let status: WorkCliSessionStatus = 'idle';

      for (let i = tailLines.length - 1; i >= 0; i -= 1) {
        const rec = tailLines[i];
        const type = rec.type;
        if (
          type === 'file-history-snapshot'
          || type === 'summary'
          || type === 'custom-title'
          || type === 'ai-title'
          || type === 'queue-operation'
        ) {
          continue;
        }
        if (type === 'system' && rec.subtype === 'turn_duration') {
          status = 'completed';
          break;
        }
        if (type === 'assistant') {
          const msg = rec.message as { stop_reason?: unknown } | undefined;
          const stopReason = msg?.stop_reason;
          if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'max_tokens') {
            status = 'completed';
          } else {
            status = (isActive || isFresh) ? 'running' : 'idle';
          }
          break;
        }
        if (type === 'user' || type === 'progress') {
          status = (isActive || isFresh) ? 'running' : 'idle';
          break;
        }
      }

      if (status === 'idle' && isActive && !hasConversationTurn) {
        status = 'running';
      }

      const title = normalizeCliSessionTitle(
        customTitle || aiTitle || summaryTitle || firstUserPrompt,
        'Claude Code 对话',
      );
      const existing = results.get(sessionId);
      if (!existing || latestTs > existing.updatedAt) {
        results.set(sessionId, {
          id: sessionId,
          provider: 'claude',
          projectId,
          title,
          status,
          updatedAt: Math.round(latestTs),
        });
      }
    }
  }

  return Array.from(results.values());
}

function isCodexSubagentSource(source: string | null | undefined): boolean {
  if (!source) return false;
  const trimmed = source.trim();
  return trimmed.startsWith('{"subagent"') || trimmed.startsWith('{"subagent":');
}

function extractFirstCodexUserMessage(lines: readonly Record<string, unknown>[]): string | undefined {
  for (const rec of lines) {
    if (rec.type === 'event_msg') {
      const ev = rec.payload as { type?: unknown; message?: unknown } | undefined;
      if (ev?.type === 'user_message' && typeof ev.message === 'string' && ev.message.trim()) {
        return ev.message;
      }
    }
  }
  return undefined;
}

async function readCodexSessionIndexMap(codexDir: string): Promise<Map<string, string>> {
  const titleByThread = new Map<string, string>();
  const indexPath = join(codexDir, 'session_index.jsonl');
  if (!existsSync(indexPath)) return titleByThread;
  try {
    const content = await readFile(indexPath, 'utf8');
    for (const rec of parseJsonLines(content)) {
      if (typeof rec.id === 'string' && typeof rec.thread_name === 'string' && rec.thread_name.trim()) {
        titleByThread.set(rec.id, rec.thread_name);
      }
    }
  } catch {
    // Ignore unreadable session_index.jsonl.
  }
  return titleByThread;
}

async function detectCodexRolloutStatus(
  rolloutPath: string | null | undefined,
  turnStatus: string | null | undefined,
  updatedAtMs: number,
  nowMs: number,
): Promise<{ status: WorkCliSessionStatus; mtimeMs: number; firstUserMessage?: string }> {
  let fileMtimeMs = 0;
  let tailStatus: WorkCliSessionStatus | null = null;
  let firstUserMessage: string | undefined;

  if (rolloutPath) {
    const cleanPath = stripWindowsExtendedPathPrefix(rolloutPath);
    const slices = await readHeadAndTail(cleanPath);
    if (slices) {
      fileMtimeMs = slices.mtimeMs;
      const headLines = parseJsonLines(slices.head);
      const tailLines = slices.tail === slices.head ? headLines : parseJsonLines(slices.tail);
      firstUserMessage = extractFirstCodexUserMessage(headLines) ?? extractFirstCodexUserMessage(tailLines);
      for (let i = tailLines.length - 1; i >= 0; i -= 1) {
        const rec = tailLines[i];
        if (rec.type !== 'event_msg') continue;
        const payload = rec.payload as { type?: unknown } | undefined;
        const payloadType = payload?.type;
        if (payloadType === 'task_complete') {
          tailStatus = 'completed';
          break;
        }
        if (payloadType === 'turn_aborted') {
          tailStatus = 'idle';
          break;
        }
        if (payloadType === 'task_started') {
          const fresh = nowMs - Math.max(fileMtimeMs, updatedAtMs) < RUNNING_STALE_MS;
          const turnRunning = turnStatus === 'inProgress' || turnStatus === 'running' || turnStatus === 'pending';
          tailStatus = (fresh || turnRunning) ? 'running' : 'idle';
          break;
        }
      }
    }
  }

  if (tailStatus) {
    return { status: tailStatus, mtimeMs: fileMtimeMs, firstUserMessage };
  }
  if (turnStatus === 'completed') {
    return { status: 'completed', mtimeMs: fileMtimeMs, firstUserMessage };
  }
  if (turnStatus === 'inProgress' || turnStatus === 'running' || turnStatus === 'pending') {
    const fresh = nowMs - Math.max(fileMtimeMs, updatedAtMs) < RUNNING_STALE_MS;
    return { status: fresh ? 'running' : 'idle', mtimeMs: fileMtimeMs, firstUserMessage };
  }
  return { status: 'idle', mtimeMs: fileMtimeMs, firstUserMessage };
}

async function readCodexFallbackJsonlSessions(options: {
  codexDir: string;
  projectId: string;
  targetNormalized: string;
  platformHint: 'win32' | 'posix';
  nowMs: number;
}): Promise<WorkCliSession[]> {
  const { codexDir, projectId, targetNormalized, platformHint, nowMs } = options;
  const sessionsRoot = join(codexDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];

  const titleByThread = await readCodexSessionIndexMap(codexDir);

  const rolloutFiles: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        rolloutFiles.push(full);
      }
    }
  }
  await walk(sessionsRoot, 0);

  const out: WorkCliSession[] = [];
  for (const filePath of rolloutFiles) {
    const slices = await readHeadAndTail(filePath);
    if (!slices) continue;
    const headLines = parseJsonLines(slices.head);
    const meta = headLines.find((item) => item.type === 'session_meta');
    const payload = meta?.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id) continue;
    if (typeof payload.source === 'string' && isCodexSubagentSource(payload.source)) continue;
    if (payload.source && typeof payload.source === 'object' && 'subagent' in (payload.source as object)) continue;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    if (!cwd || normalizeProjectDirectory(cwd, platformHint) !== targetNormalized) continue;
    const sessionId = typeof payload.id === 'string' ? payload.id : '';
    if (!isValidCliSessionId(sessionId)) continue;

    const firstUser = extractFirstCodexUserMessage(headLines) ?? '';

    const detected = await detectCodexRolloutStatus(filePath, null, slices.mtimeMs, nowMs);
    out.push({
      id: sessionId,
      provider: 'codex',
      projectId,
      title: normalizeCliSessionTitle(titleByThread.get(sessionId) || firstUser, 'Codex 对话'),
      status: detected.status,
      updatedAt: Math.round(slices.mtimeMs),
    });
  }
  return out;
}

async function readLocalCodexSessions(options: {
  codexDir: string;
  projectId: string;
  projectDir: string;
  platformHint: 'win32' | 'posix';
  nowMs: number;
}): Promise<WorkCliSession[]> {
  const { codexDir, projectId, projectDir, platformHint, nowMs } = options;
  if (!existsSync(codexDir)) return [];

  const targetNormalized = normalizeProjectDirectory(projectDir, platformHint);
  const stateDbPath = join(codexDir, 'state_5.sqlite');
  if (!existsSync(stateDbPath)) {
    return readCodexFallbackJsonlSessions({
      codexDir,
      projectId,
      targetNormalized,
      platformHint,
      nowMs,
    });
  }

  type ThreadRow = {
    id: string;
    rollout_path: string;
    cwd: string;
    title: string;
    name: string | null;
    first_user_message: string;
    preview: string;
    source: string;
    updated_at: number;
    updated_at_ms: number | null;
    attached_thread_parent_id: string | null;
  };

  let rows: ThreadRow[] = [];
  let stateDb: DatabaseSync | null = null;
  try {
    stateDb = new DatabaseSync(stateDbPath, { readOnly: true });
    rows = stateDb.prepare(
      `SELECT id, rollout_path, cwd, title, name, first_user_message, preview, source,
              updated_at, updated_at_ms, attached_thread_parent_id
       FROM threads
       WHERE archived = 0
         AND (attached_thread_parent_id IS NULL OR attached_thread_parent_id = '')
       ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC`,
    ).all() as ThreadRow[];
  } catch {
    return readCodexFallbackJsonlSessions({
      codexDir,
      projectId,
      targetNormalized,
      platformHint,
      nowMs,
    });
  } finally {
    try { stateDb?.close(); } catch { /* ignore */ }
  }

  const matched = rows.filter((row) => (
    isValidCliSessionId(row.id)
    && !isCodexSubagentSource(row.source)
    && normalizeProjectDirectory(row.cwd, platformHint) === targetNormalized
  ));
  if (matched.length === 0) return [];

  const latestTurnByThread = new Map<string, string>();
  const historyDbPath = join(codexDir, 'thread_history_1.sqlite');
  if (existsSync(historyDbPath)) {
    let histDb: DatabaseSync | null = null;
    try {
      histDb = new DatabaseSync(historyDbPath, { readOnly: true });
      const stmt = histDb.prepare(
        'SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1',
      );
      for (const row of matched) {
        const turn = stmt.get(row.id) as { status?: string } | undefined;
        if (turn?.status) latestTurnByThread.set(row.id, turn.status);
      }
    } catch {
      // Ignore optional thread_history_1.sqlite read errors.
    } finally {
      try { histDb?.close(); } catch { /* ignore */ }
    }
  }

  const indexTitles = await readCodexSessionIndexMap(codexDir);
  const sessions: WorkCliSession[] = [];
  for (const row of matched) {
    const dbUpdatedAt = parseIsoTimestampMs(row.updated_at_ms || row.updated_at);
    const detected = await detectCodexRolloutStatus(
      row.rollout_path,
      latestTurnByThread.get(row.id) ?? null,
      dbUpdatedAt,
      nowMs,
    );
    const updatedAt = Math.max(dbUpdatedAt, detected.mtimeMs);
    sessions.push({
      id: row.id,
      provider: 'codex',
      projectId,
      title: normalizeCliSessionTitle(
        row.name || indexTitles.get(row.id) || row.title || row.first_user_message || row.preview || detected.firstUserMessage,
        'Codex 对话',
      ),
      status: detected.status,
      updatedAt: Math.round(updatedAt),
    });
  }
  return sessions;
}

function parseWorkspaceUris(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

async function readLocalAntigravitySessions(options: {
  agyDir: string;
  projectId: string;
  projectDir: string;
  platformHint: 'win32' | 'posix';
  nowMs: number;
}): Promise<WorkCliSession[]> {
  const { agyDir, projectId, projectDir, platformHint, nowMs } = options;
  const summariesDbPath = join(agyDir, 'conversation_summaries.db');
  if (!existsSync(summariesDbPath)) return [];

  const targetNormalized = normalizeProjectDirectory(projectDir, platformHint);

  type SummaryRow = {
    conversation_id: string;
    title: string;
    preview: string;
    step_count: number;
    last_modified_time: string;
    workspace_uris: string;
    status: string;
    last_user_input_time: string;
  };

  let rows: SummaryRow[] = [];
  let sumDb: DatabaseSync | null = null;
  try {
    sumDb = new DatabaseSync(summariesDbPath, { readOnly: true });
    rows = sumDb.prepare(
      `SELECT conversation_id, title, preview, step_count, last_modified_time,
              workspace_uris, status, last_user_input_time
       FROM conversation_summaries
       WHERE killed = 0
         AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)
         AND nesting_depth = 0
       ORDER BY last_modified_time DESC`,
    ).all() as SummaryRow[];
  } catch {
    return [];
  } finally {
    try { sumDb?.close(); } catch { /* ignore */ }
  }

  const out: WorkCliSession[] = [];
  for (const row of rows) {
    if (!isValidCliSessionId(row.conversation_id)) continue;
    const uris = parseWorkspaceUris(row.workspace_uris);
    const matchesProject = uris.some((uri) => {
      const converted = fileUriToPath(uri);
      return converted !== null && normalizeProjectDirectory(converted, platformHint) === targetNormalized;
    });
    if (!matchesProject) continue;

    let updatedAt = Math.max(
      parseIsoTimestampMs(row.last_modified_time),
      parseIsoTimestampMs(row.last_user_input_time),
    );
    let status: WorkCliSessionStatus = 'idle';

    if (row.status === 'CASCADE_RUN_STATUS_RUNNING') {
      let convDbMtimeMs = 0;
      let hasActiveStep = false;
      const convDbPath = join(agyDir, 'conversations', `${row.conversation_id}.db`);
      if (existsSync(convDbPath)) {
        try {
          convDbMtimeMs = (await stat(convDbPath)).mtimeMs;
          const convDb = new DatabaseSync(convDbPath, { readOnly: true });
          try {
            const tailSteps = convDb.prepare(
              'SELECT status FROM steps ORDER BY idx DESC LIMIT 5',
            ).all() as Array<{ status: number }>;
            hasActiveStep = tailSteps.some((step) => step.status === 1 || step.status === 2);
          } finally {
            convDb.close();
          }
        } catch {
          // Ignore locked/missing per-conversation DB; rely on summary timestamp.
        }
      }
      const freshest = Math.max(updatedAt, convDbMtimeMs);
      updatedAt = freshest;
      status = (nowMs - freshest < RUNNING_STALE_MS || hasActiveStep && nowMs - freshest < RUNNING_STALE_MS)
        ? 'running'
        : 'idle';
    } else if (
      row.status === 'CASCADE_RUN_STATUS_IDLE'
      || row.status === 'CASCADE_RUN_STATUS_WAITING_FOR_USER'
      || Number(row.step_count) > 0
    ) {
      status = 'completed';
    }

    out.push({
      id: row.conversation_id,
      provider: 'antigravity',
      projectId,
      title: normalizeCliSessionTitle(row.title || row.preview, 'Antigravity 对话'),
      status,
      updatedAt: Math.round(updatedAt),
    });
  }
  return out;
}

const REMOTE_PYTHON_CLI_PROBE = [
  'import glob, json, os, re, sqlite3, sys, time, urllib.parse',
  'target_raw = sys.argv[1] if len(sys.argv) > 1 else ""',
  'limit = max(1, min(200, int(sys.argv[2]) if len(sys.argv) > 2 else 30))',
  'home = os.path.expanduser("~")',
  'now_ms = int(time.time() * 1000)',
  'STALE_MS = 30 * 60 * 1000',
  'ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")',
  'def norm_posix(p):',
  '  p = (p or "").strip()',
  '  if p == "~": p = home',
  '  elif p.startswith("~/"): p = home + p[1:]',
  '  p = p.replace("\\\\", "/")',
  '  while len(p) > 1 and p.endswith("/"): p = p[:-1]',
  '  return p',
  'def clean_title(s, fb):',
  '  if not s: return fb',
  '  s = re.sub(r"<(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|local-command-stdout)>.*?</(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|local-command-stdout)>", " ", str(s), flags=re.S | re.I)',
  '  s = re.sub(r"</?[a-zA-Z0-9_-]+>", " ", s)',
  '  s = re.sub(r"\\s+", " ", s).strip()',
  '  return fb if not s else (s if len(s) <= 120 else s[:119].rstrip() + "…")',
  'def parse_ts(v):',
  '  if isinstance(v, (int, float)): return int(v if v > 1e12 else v * 1000)',
  '  if not isinstance(v, str) or not v.strip(): return 0',
  '  from datetime import datetime',
  '  s = v.strip().replace(" ", "T")',
  '  s = re.sub(r"\\.(\\d{6})\\d+", r".\\1", s)',
  '  if s.endswith("Z"): s = s[:-1] + "+00:00"',
  '  try: return int(datetime.fromisoformat(s).timestamp() * 1000)',
  '  except Exception: return 0',
  'def read_head_tail(p, h=16384, t=32768):',
  '  try:',
  '    st = os.stat(p)',
  '    sz = st.st_size',
  '    with open(p, "rb") as f:',
  '      if sz <= h + t:',
  '        txt = f.read().decode("utf-8", "replace")',
  '        return txt, txt, int(st.st_mtime * 1000)',
  '      hd = f.read(h).decode("utf-8", "replace")',
  '      f.seek(max(0, sz - t))',
  '      tl = f.read(t).decode("utf-8", "replace")',
  '      nl = tl.find("\\n")',
  '      tl = tl[nl+1:] if nl >= 0 else ""',
  '      return hd, tl, int(st.st_mtime * 1000)',
  '  except Exception: return None',
  'def parse_jsonl(txt):',
  '  out = []',
  '  for ln in txt.splitlines():',
  '    ln = ln.strip()',
  '    if not ln: continue',
  '    try:',
  '      obj = json.loads(ln)',
  '      if isinstance(obj, dict): out.append(obj)',
  '    except Exception: pass',
  '  return out',
  'target = norm_posix(target_raw)',
  'items = []',
  '# 1. Claude Code',
  'claude_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")',
  'active_claude = set()',
  'for sf in glob.glob(os.path.join(claude_dir, "sessions", "*.json")):',
  '  try:',
  '    d = json.load(open(sf, "r", encoding="utf-8"))',
  '    pid = d.get("pid"); sid = d.get("sessionId")',
  '    if isinstance(pid, int) and pid > 0 and isinstance(sid, str) and ID_RE.match(sid):',
  '      try: os.kill(pid, 0); active_claude.add(sid)',
  '      except OSError: pass',
  '  except Exception: pass',
  'c_proj_root = os.path.join(claude_dir, "projects")',
  'if os.path.isdir(c_proj_root):',
  '  slug = re.sub(r"[^A-Za-z0-9]", "-", target)',
  '  folders = []',
  '  for name in os.listdir(c_proj_root):',
  '    fp = os.path.join(c_proj_root, name)',
  '    if not os.path.isdir(fp): continue',
  '    if name == slug: folders.append(fp)',
  '    else:',
  '      idxp = os.path.join(fp, "sessions-index.json")',
  '      if os.path.isfile(idxp):',
  '        try:',
  '          idx = json.load(open(idxp, "r", encoding="utf-8"))',
  '          op = idx.get("originalPath") or ((idx.get("entries") or [{}])[0].get("projectPath"))',
  '          if op and norm_posix(op) == target: folders.append(fp)',
  '        except Exception: pass',
  '  for folder in folders:',
  '    idx_map = {}',
  '    idxp = os.path.join(folder, "sessions-index.json")',
  '    if os.path.isfile(idxp):',
  '      try:',
  '        for e in json.load(open(idxp, "r", encoding="utf-8")).get("entries", []):',
  '          if isinstance(e, dict) and isinstance(e.get("sessionId"), str): idx_map[e["sessionId"]] = e',
  '      except Exception: pass',
  '    for fn in os.listdir(folder):',
  '      if not fn.endswith(".jsonl") or fn.startswith("agent-"): continue',
  '      sid = fn[:-6]',
  '      if not ID_RE.match(sid): continue',
  '      im = idx_map.get(sid, {})',
  '      if im.get("isSidechain"): continue',
  '      ht = read_head_tail(os.path.join(folder, fn))',
  '      if not ht: continue',
  '      hl = parse_jsonl(ht[0]); tl = hl if ht[1] == ht[0] else parse_jsonl(ht[1])',
  '      if any(r.get("isSidechain") is True for r in hl): continue',
  '      ct, ait, st, fu, has_turn = im.get("customTitle"), None, im.get("summary"), im.get("firstPrompt"), False',
  '      for r in hl:',
  '        if r.get("type") in ("user", "assistant"): has_turn = True',
  '        if r.get("type") == "custom-title" and isinstance(r.get("customTitle"), str): ct = r["customTitle"]',
  '        elif r.get("type") == "ai-title" and isinstance(r.get("aiTitle"), str): ait = r["aiTitle"]',
  '        elif r.get("type") == "summary" and isinstance(r.get("summary"), str): st = r["summary"]',
  '        elif r.get("type") == "user" and not r.get("isMeta") and not fu:',
  '          mc = (r.get("message") or {}).get("content")',
  '          txt = mc if isinstance(mc, str) else " ".join(b.get("text", "") for b in (mc or []) if isinstance(b, dict) and b.get("type") == "text")',
  '          if txt.strip() and not re.match(r"^<(?:local-command-|command-name|command-message|system-reminder)", txt.strip()): fu = txt',
  '      ts = ht[2]',
  '      for r in tl:',
  '        if r.get("type") in ("user", "assistant"): has_turn = True',
  '        if r.get("type") == "custom-title" and isinstance(r.get("customTitle"), str): ct = r["customTitle"]',
  '        elif r.get("type") == "ai-title" and isinstance(r.get("aiTitle"), str): ait = r["aiTitle"]',
  '        elif r.get("type") == "summary" and isinstance(r.get("summary"), str): st = r["summary"]',
  '        ts = max(ts, parse_ts(r.get("timestamp")))',
  '      if not has_turn and not ct and not ait and not st and sid not in active_claude: continue',
  '      status = "idle"',
  '      is_act = sid in active_claude; fresh = (now_ms - ts) < STALE_MS',
  '      for r in reversed(tl):',
  '        tp = r.get("type")',
  '        if tp in ("file-history-snapshot", "summary", "custom-title", "ai-title", "queue-operation"): continue',
  '        if tp == "system" and r.get("subtype") == "turn_duration": status = "completed"; break',
  '        if tp == "assistant":',
  '          sr = (r.get("message") or {}).get("stop_reason")',
  '          status = "completed" if sr in ("end_turn", "stop_sequence", "max_tokens") else ("running" if (is_act or fresh) else "idle")',
  '          break',
  '        if tp in ("user", "progress"): status = "running" if (is_act or fresh) else "idle"; break',
  '      items.append({"id": sid, "provider": "claude", "title": clean_title(ct or ait or st or fu, "Claude Code 对话"), "status": status, "updatedAt": ts})',
  '# 2. Codex',
  'codex_dir = os.environ.get("CODEX_HOME") or os.path.join(home, ".codex")',
  'codex_idx = {}',
  'codex_idx_p = os.path.join(codex_dir, "session_index.jsonl")',
  'if os.path.isfile(codex_idx_p):',
  '  try:',
  '    for r in parse_jsonl(open(codex_idx_p, "r", encoding="utf-8", errors="ignore").read()):',
  '      if isinstance(r.get("id"), str) and isinstance(r.get("thread_name"), str) and r["thread_name"].strip(): codex_idx[r["id"]] = r["thread_name"]',
  '  except Exception: pass',
  'state_db_p = os.path.join(codex_dir, "state_5.sqlite")',
  'if os.path.isfile(state_db_p):',
  '  try:',
  '    sdb = sqlite3.connect(f"file:{state_db_p}?mode=ro", uri=True)',
  '    hdb_p = os.path.join(codex_dir, "thread_history_1.sqlite")',
  '    hdb = sqlite3.connect(f"file:{hdb_p}?mode=ro", uri=True) if os.path.isfile(hdb_p) else None',
  '    for tid, rp, cwd, title, name, fum, preview, src, uat, uams, parent in sdb.execute("SELECT id, rollout_path, cwd, title, name, first_user_message, preview, source, updated_at, updated_at_ms, attached_thread_parent_id FROM threads WHERE archived = 0"):',
  '      if parent or not tid or not ID_RE.match(tid): continue',
  '      if isinstance(src, str) and src.strip().startswith("{\\"subagent\\""): continue',
  '      if norm_posix(cwd) != target: continue',
  '      uat_ms = parse_ts(uams or uat)',
  '      turn_st = None',
  '      if hdb:',
  '        row_t = hdb.execute("SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1", (tid,)).fetchone()',
  '        if row_t: turn_st = row_t[0]',
  '      st = "idle"; mtime = 0; fum_rollout = None',
  '      if rp and os.path.isfile(rp):',
  '        ht = read_head_tail(rp, 16384, 32768)',
  '        if ht:',
  '          mtime = ht[2]',
  '          hl = parse_jsonl(ht[0]); tl = hl if ht[1] == ht[0] else parse_jsonl(ht[1])',
  '          for r in (hl + tl):',
  '            if r.get("type") == "event_msg" and (r.get("payload") or {}).get("type") == "user_message" and isinstance((r.get("payload") or {}).get("message"), str) and (r.get("payload") or {}).get("message").strip():',
  '              fum_rollout = r["payload"]["message"]; break',
  '          for r in reversed(tl):',
  '            if r.get("type") != "event_msg": continue',
  '            pt = (r.get("payload") or {}).get("type")',
  '            if pt == "task_complete": st = "completed"; break',
  '            if pt == "turn_aborted": st = "idle"; break',
  '            if pt == "task_started":',
  '              fresh = (now_ms - max(mtime, uat_ms)) < STALE_MS',
  '              st = "running" if (fresh or turn_st in ("inProgress", "running", "pending")) else "idle"',
  '              break',
  '      if st == "idle" and turn_st == "completed": st = "completed"',
  '      elif st == "idle" and turn_st in ("inProgress", "running", "pending") and (now_ms - max(mtime, uat_ms)) < STALE_MS: st = "running"',
  '      items.append({"id": tid, "provider": "codex", "title": clean_title(name or codex_idx.get(tid) or title or fum or preview or fum_rollout, "Codex 对话"), "status": st, "updatedAt": max(uat_ms, mtime)})',
  '    if hdb: hdb.close()',
  '    sdb.close()',
  '  except Exception: pass',
  '# 3. Antigravity',
  'agy_dir = os.environ.get("ANTIGRAVITY_CLI_HOME") or os.path.join(home, ".gemini", "antigravity-cli")',
  'sum_db_p = os.path.join(agy_dir, "conversation_summaries.db")',
  'if os.path.isfile(sum_db_p):',
  '  try:',
  '    adb = sqlite3.connect(f"file:{sum_db_p}?mode=ro", uri=True)',
  '    for cid, title, preview, step_cnt, lmt, uris_json, rstatus, luit in adb.execute("SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, last_user_input_time FROM conversation_summaries WHERE killed = 0 AND (parent_conversation_id = \'\' OR parent_conversation_id IS NULL) AND nesting_depth = 0"):',
  '      if not cid or not ID_RE.match(cid): continue',
  '      try: uris = json.loads(uris_json or "[]")',
  '      except Exception: uris = []',
  '      matched = False',
  '      for u in uris:',
  '        if isinstance(u, str) and u.lower().startswith("file://"):',
  '          p = urllib.parse.unquote(urllib.parse.urlparse(u).path)',
  '          if norm_posix(p) == target: matched = True; break',
  '      if not matched: continue',
  '      ts = max(parse_ts(lmt), parse_ts(luit))',
  '      st = "idle"',
  '      if rstatus == "CASCADE_RUN_STATUS_RUNNING":',
  '        cdb_p = os.path.join(agy_dir, "conversations", cid + ".db")',
  '        has_act = False',
  '        if os.path.isfile(cdb_p):',
  '          try:',
  '            ts = max(ts, int(os.stat(cdb_p).st_mtime * 1000))',
  '            cdb = sqlite3.connect(f"file:{cdb_p}?mode=ro", uri=True)',
  '            has_act = any(row[0] in (1, 2) for row in cdb.execute("SELECT status FROM steps ORDER BY idx DESC LIMIT 5"))',
  '            cdb.close()',
  '          except Exception: pass',
  '        st = "running" if ((now_ms - ts) < STALE_MS or (has_act and (now_ms - ts) < STALE_MS)) else "idle"',
  '      elif rstatus in ("CASCADE_RUN_STATUS_IDLE", "CASCADE_RUN_STATUS_WAITING_FOR_USER") or (step_cnt or 0) > 0:',
  '        st = "completed"',
  '      items.append({"id": cid, "provider": "antigravity", "title": clean_title(title or preview, "Antigravity 对话"), "status": st, "updatedAt": ts})',
  '    adb.close()',
  '  except Exception: pass',
  'items.sort(key=lambda x: (-x["updatedAt"], x["id"]))',
  'total = len(items)',
  'print(json.dumps({"items": items[:limit], "total": total, "hasMore": total > limit}, ensure_ascii=False))',
].join('\n');

export function createWorkCliSessionService(options: {
  db: AppDatabase;
  runCommand?: HostCommandRunner;
  wslCommand?: string | null;
  currentPlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeHostSecrets?: Map<string, string>;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}): WorkCliSessionService {
  const { db } = options;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const currentPlatform = options.currentPlatform ?? process.platform;
  const env = options.env ?? process.env;
  const wslCommand = options.wslCommand !== undefined ? options.wslCommand : resolveWslCommand(currentPlatform);
  const homeDir = options.homeDir ?? homedir();
  const runtimeHostSecrets = options.runtimeHostSecrets ?? new Map<string, string>();
  const now = options.now ?? (() => Date.now());
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  function parseRemoteProbeOutput(
    projectId: string,
    stdout: Buffer,
  ): WorkProjectCliSessionsResponse {
    const text = decodeWslText(stdout).trim();
    if (!text) {
      return { projectId, items: [], total: 0, hasMore: false };
    }
    const parsed = JSON.parse(text) as {
      items?: Array<{
        id?: string;
        provider?: WorkCliProvider;
        title?: string;
        status?: WorkCliSessionStatus;
        updatedAt?: number;
      }>;
      total?: number;
      hasMore?: boolean;
    };
    const items: WorkCliSession[] = [];
    for (const item of parsed.items ?? []) {
      if (
        typeof item.id !== 'string'
        || !isValidCliSessionId(item.id)
        || (item.provider !== 'claude' && item.provider !== 'codex' && item.provider !== 'antigravity')
      ) {
        continue;
      }
      const status: WorkCliSessionStatus = item.status === 'running' || item.status === 'completed'
        ? item.status
        : 'idle';
      items.push({
        id: item.id,
        provider: item.provider,
        projectId,
        title: normalizeCliSessionTitle(item.title, 'CLI 对话'),
        status,
        updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      });
    }
    const total = typeof parsed.total === 'number' && Number.isFinite(parsed.total) ? parsed.total : items.length;
    return {
      projectId,
      items,
      total,
      hasMore: Boolean(parsed.hasMore),
    };
  }

  async function listWslCliSessions(
    hostRow: WorkHostRow,
    projectId: string,
    projectDirectory: string,
    limit: number,
  ): Promise<WorkProjectCliSessionsResponse> {
    if (!wslCommand) {
      throw new AppError(400, 'wsl_unavailable', '当前运行环境无法读取该 WSL 发行版的 CLI 会话。');
    }
    const runningCheck = await ensureWslDistroRunning(wslCommand, hostRow.distro, runCommand);
    if (!runningCheck.ok) {
      if (runningCheck.code === 'enoent') throw new AppError(400, 'wsl_unavailable', runningCheck.message);
      if (runningCheck.code === 'timed_out') throw new AppError(504, 'cli_probe_timeout', runningCheck.message);
      throw new AppError(502, 'cli_probe_failed', runningCheck.message);
    }

    const args = ['-d', hostRow.distro];
    if (hostRow.username) args.push('--user', hostRow.username);
    args.push(
      '--exec',
      'sh',
      '-c',
      'command -v python3 >/dev/null 2>&1 || exit 127; exec python3 -c "$1" "$2" "$3"',
      '_',
      REMOTE_PYTHON_CLI_PROBE,
      projectDirectory,
      String(limit),
    );

    const result = await runCommand(wslCommand, args, {
      timeoutMs: REMOTE_CLI_TIMEOUT_MS,
      env: { WSL_UTF8: '1' },
    });

    if (result.code === 127) {
      return { projectId, items: [], total: 0, hasMore: false };
    }
    if (result.timedOut) {
      throw new AppError(504, 'cli_probe_timeout', `读取 WSL 发行版 ${hostRow.distro} 的 CLI 会话超时。`);
    }
    if (result.code !== 0) {
      throw new AppError(502, 'cli_probe_failed', `读取 WSL 发行版 ${hostRow.distro} 的 CLI 会话失败。`);
    }
    try {
      return parseRemoteProbeOutput(projectId, result.stdout);
    } catch {
      return { projectId, items: [], total: 0, hasMore: false };
    }
  }

  async function listSshCliSessions(
    hostRow: WorkHostRow,
    projectId: string,
    projectDirectory: string,
    limit: number,
  ): Promise<WorkProjectCliSessionsResponse> {
    const resolvedSecret = runtimeHostSecrets.get(fromDbUuid(hostRow.id)) || hostRow.secret_value;
    if (rowNeedsPassword(hostRow, resolvedSecret)) {
      throw new AppError(401, 'ssh_auth_required', '未保存 SSH 密码，请先连接或解锁主机后再查看 CLI 会话。');
    }

    const args = [
      '-T',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(hostRow.port),
    ];
    const cmdEnv: Record<string, string> = {};
    if (resolvedSecret) {
      args.push('-o', 'NumberOfPasswordPrompts=1');
      cmdEnv.SSH_ASKPASS = ensureAskpassScript();
      cmdEnv.SSH_ASKPASS_REQUIRE = 'force';
      cmdEnv.DISPLAY = env.DISPLAY || 'matrius:0';
      cmdEnv.MATRIUS_SSH_PASS = resolvedSecret;
    } else {
      args.push('-o', 'BatchMode=yes');
      if (hostRow.auth_method === 'key' && hostRow.private_key_path) {
        args.push('-i', expandHomePath(hostRow.private_key_path), '-o', 'IdentitiesOnly=yes');
      }
    }

    const target = rowSshTarget(hostRow);
    const remoteScript = [
      'command -v python3 >/dev/null 2>&1 || exit 127;',
      `exec python3 -c ${posixSingleQuote(REMOTE_PYTHON_CLI_PROBE)} ${posixSingleQuote(projectDirectory)} ${posixSingleQuote(String(limit))}`,
    ].join(' ');
    args.push('--', target, `sh -c ${posixSingleQuote(remoteScript)}`);

    const result = await runCommand('ssh', args, {
      timeoutMs: REMOTE_CLI_TIMEOUT_MS,
      env: cmdEnv,
    });

    if (result.errorCode === 'ENOENT') {
      throw new AppError(400, 'ssh_unavailable', '本机未找到 ssh 客户端。');
    }
    if (result.code === 127) {
      return { projectId, items: [], total: 0, hasMore: false };
    }
    if (result.timedOut) {
      throw new AppError(504, 'cli_probe_timeout', `读取远程主机 ${hostRow.name} 的 CLI 会话超时。`);
    }
    if (result.code !== 0) {
      throw new AppError(502, 'cli_probe_failed', `读取远程主机 ${hostRow.name} 的 CLI 会话失败。`);
    }
    try {
      return parseRemoteProbeOutput(projectId, result.stdout);
    } catch {
      return { projectId, items: [], total: 0, hasMore: false };
    }
  }

  return {
    async listByProject(projectId, listOptions = {}) {
      const limit = clampFetchLimit(listOptions.limit);
      const project = serializeWorkProject(requireWorkProjectRow(db, INSTANCE_ID, projectId));

      if (project.hostId !== LOCAL_WORK_HOST_ID) {
        const hostRow = requireWorkHostRow(db, INSTANCE_ID, project.hostId);
        if (hostRow.kind === 'wsl') {
          return listWslCliSessions(hostRow, project.id, project.directory, limit);
        }
        return listSshCliSessions(hostRow, project.id, project.directory, limit);
      }

      const nowMs = now();
      const platformHint: 'win32' | 'posix' = currentPlatform === 'win32' ? 'win32' : 'posix';
      const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homeDir, '.claude');
      const codexDir = env.CODEX_HOME?.trim() || join(homeDir, '.codex');
      const agyDir = env.ANTIGRAVITY_CLI_HOME?.trim() || join(homeDir, '.gemini', 'antigravity-cli');

      const [claudeItems, codexItems, agyItems] = await Promise.all([
        readLocalClaudeSessions({
          claudeDir,
          projectId: project.id,
          projectDir: project.directory,
          platformHint,
          nowMs,
          isPidAlive,
        }),
        readLocalCodexSessions({
          codexDir,
          projectId: project.id,
          projectDir: project.directory,
          platformHint,
          nowMs,
        }),
        readLocalAntigravitySessions({
          agyDir,
          projectId: project.id,
          projectDir: project.directory,
          platformHint,
          nowMs,
        }),
      ]);

      const combined = [...claudeItems, ...codexItems, ...agyItems].sort(
        (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
      return {
        projectId: project.id,
        items: combined.slice(0, limit),
        total: combined.length,
        hasMore: combined.length > limit,
      };
    },
  };
}

function rowNeedsPassword(row: WorkHostRow, resolvedSecret: string | undefined): boolean {
  return row.auth_method === 'password' && !resolvedSecret;
}

function rowSshTarget(row: WorkHostRow): string {
  return row.username ? `${row.username}@${row.host}` : row.host;
}
