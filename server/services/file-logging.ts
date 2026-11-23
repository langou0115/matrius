import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_LOG_BYTES = 10 * 1024 * 1024;

const consoleLevels: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

export function createLogStream(consoleLevel: string, directory = join(homedir(), '.matrius', 'logs'), maxBytes = MAX_LOG_BYTES) {
  const path = join(directory, 'server.log');
  let reportedFailure = false;
  return {
    write(line: string) {
      const record = JSON.parse(line) as { level: number; time: number };
      if (record.level >= (consoleLevels[consoleLevel] ?? 30)) process.stdout.write(line);
      if (record.level < 30) return;
      const level = record.level >= 50 ? 'error' : record.level >= 40 ? 'warning' : 'info';
      let entry = JSON.stringify({ ...record, level }) + '\n';
      let bytes = Buffer.byteLength(entry);
      if (bytes > maxBytes) {
        entry = JSON.stringify({ level, time: record.time, msg: 'Log entry exceeded the file size limit.' }) + '\n';
        bytes = Buffer.byteLength(entry);
      }
      if (bytes > maxBytes) return;

      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
        if (size + bytes > maxBytes) renameSync(path, join(directory, 'server.log.1'));
        appendFileSync(path, entry, { mode: 0o600 });
        reportedFailure = false;
      } catch (error) {
        if (!reportedFailure) console.error('Unable to write Matrius log file:', error);
        reportedFailure = true;
      }
    },
  };
}
