import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLogStream } from '../services/file-logging';

test('file logging filters debug, labels levels and retains only two bounded files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-logs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const maxBytes = 140;
  const stream = createLogStream('silent', directory, maxBytes);
  const write = (level: number, msg = '日志'.repeat(12)) => stream.write(JSON.stringify({ level, msg, time: 0 }));
  const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));

  write(20);
  assert.deepEqual(readdirSync(directory), []);
  write(30);
  write(40);
  assert.equal(read('server.log.1').level, 'info');
  assert.equal(read('server.log').level, 'warning');
  write(50, '长日志'.repeat(100));
  assert.equal(read('server.log.1').level, 'warning');
  assert.equal(read('server.log').level, 'error');
  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ['server.log', 'server.log.1']);
  for (const file of files) assert.ok(statSync(join(directory, file)).size <= maxBytes);
});
