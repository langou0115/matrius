import { spawn } from 'node:child_process';

export type ProcessResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
};

export type RunProcessOptions = {
  stdin?: Buffer;
  timeoutSeconds: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: Record<string, string>;
};

const ENV_KEYS = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export const DOCUMENT_SEMAPHORE = new Semaphore(2);

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  env.LANG ??= 'C.UTF-8';
  env.LC_ALL ??= 'C.UTF-8';
  return { ...env, ...extra };
}

function killProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Bounded child-process execution with no shell and a whitelisted environment. */
export async function runProcess(argv: string[], options: RunProcessOptions): Promise<ProcessResult> {
  return DOCUMENT_SEMAPHORE.run(async () => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: childEnv(options.env),
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(child.pid);
    }, options.timeoutSeconds * 1000);

    const completion = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(timedOut ? -1 : exitCode ?? 0));
    });

    const state = { size: 0, truncated: false };
    const read = (stream: NodeJS.ReadableStream | null): Promise<Buffer> => new Promise((resolve) => {
      if (!stream) {
        resolve(Buffer.alloc(0));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        const remaining = options.maxOutputBytes - state.size;
        if (remaining <= 0) {
          state.truncated = true;
          return;
        }
        const buffer = Buffer.from(chunk);
        if (buffer.length > remaining) {
          chunks.push(buffer.subarray(0, remaining));
          state.size += remaining;
          state.truncated = true;
          return;
        }
        chunks.push(buffer);
        state.size += buffer.length;
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', () => resolve(Buffer.concat(chunks)));
    });

    if (options.stdin && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }

    const [stdout, stderr, code] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      completion,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr, truncated: state.truncated };
  });
}
