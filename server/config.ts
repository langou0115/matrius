import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { z } from 'zod';

const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SERVER_DIR, '..');

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().default('http://localhost:8000'),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  DATA_DIR: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).default(10_000),
  CACHE_MAX_BYTES: z.coerce.number().int().min(1).default(64 * 1024 * 1024),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(20 * 1024 * 1024),
  ENABLE_DEBUG_PAGE: z.enum(['true', 'false']).optional(),
  SEARCH_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(8),
  SEARCH_DDGS_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(4),
  SEARCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(2),
  SEARCH_FALLBACK: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  SEARCH_BREAKER_FAILURES: z.coerce.number().int().min(0).default(3),
  SEARCH_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  SEARCH_MAX_BYTES: z.coerce.number().int().min(1).default(2 * 1024 * 1024),
  SEARCH_USER_AGENT: z.string().default(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Matrius/0.1',
  ),
  WEBTOOL_PROXY_URL: z.string().default(''),
  // Per network attempt, not the whole page. FETCH_MAX_ATTEMPTS retries ride out transient
  // proxy stalls, so a page can use up to timeout × attempts before failing.
  FETCH_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(3),
  FETCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(2),
  FETCH_MAX_BYTES: z.coerce.number().int().min(1).default(5 * 1024 * 1024),
  FETCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(600),
  FETCH_MAX_CHARS: z.coerce.number().int().min(1).default(50_000),
  TOOL_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  OFFICECLI_PATH: z.string().default(''),
  OFFICECLI_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
  OFFICECLI_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1).default(16 * 1024 * 1024),
  DOCUMENT_TOOL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(120),
  DOCUMENT_DRAFT_TTL_SECONDS: z.coerce.number().int().min(1).default(1_800),
  DOCUMENT_DRAFT_MAX_COUNT: z.coerce.number().int().min(1).default(10),
  DOCUMENT_DRAFT_MAX_BYTES: z.coerce.number().int().min(1).default(60 * 1024 * 1024),
});

export type Environment = z.infer<typeof environmentSchema>;

export type Settings = Environment & {
  readonly repoRoot: string;
  readonly serverRoot: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly corsOrigins: string[];
  readonly enableDebugPage: boolean;
};

function readEnvFile(path: string): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Extract the file path from the `sqlite+aiosqlite:///...` URL used by the Python server. */
export function sqlitePathFromUrl(databaseUrl: string): string | null {
  const match = /^sqlite(?:\+[^:]+)?:\/\/(.*)$/u.exec(databaseUrl.trim());
  if (!match) return null;
  let path = match[1] ?? '';
  // POSIX absolute paths keep one slash; a Windows drive path arrives as `/D:/...`.
  if (path.startsWith('/') && /^[A-Za-z]:\//u.test(path.slice(1))) path = path.slice(1);
  return path || null;
}

function resolveFrom(base: string, value: string): string {
  const expanded = value.startsWith('~')
    ? resolve(process.env.HOME ?? process.env.USERPROFILE ?? base, value.slice(1))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Load configuration once per process.
 *
 * Development reads the repository `.env.local` as a second source, mirroring the
 * Python server. Production never reads that file; the container environment is
 * the only source of configuration there.
 */
export function loadSettings(processEnv: NodeJS.ProcessEnv = process.env): Settings {
  const envFile = processEnv.APP_ENV === 'production' ? {} : readEnvFile(resolve(REPO_ROOT, '.env.local'));
  const parsed = environmentSchema.parse({ ...envFile, ...processEnv });

  const dataDir = parsed.DATA_DIR
    ? resolveFrom(REPO_ROOT, parsed.DATA_DIR)
    : resolve(SERVER_DIR, '.data');
  const databaseUrlPath = parsed.DATABASE_URL ? sqlitePathFromUrl(parsed.DATABASE_URL) : null;
  const databasePath = databaseUrlPath
    ? resolveFrom(SERVER_DIR, databaseUrlPath)
    : resolve(dataDir, 'matrius.db');

  return {
    ...parsed,
    repoRoot: REPO_ROOT,
    serverRoot: SERVER_DIR,
    dataDir,
    databasePath,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    // The debug page is a development tool and is off in production unless
    // explicitly enabled.
    enableDebugPage: parsed.ENABLE_DEBUG_PAGE !== undefined
      ? parsed.ENABLE_DEBUG_PAGE === 'true'
      : parsed.APP_ENV !== 'production',
  };
}

let cached: Settings | undefined;

export function getSettings(): Settings {
  cached ??= loadSettings();
  return cached;
}

/** Test helper: forget the process-wide settings so a new environment can be read. */
export function resetSettingsForTests(): void {
  cached = undefined;
}
