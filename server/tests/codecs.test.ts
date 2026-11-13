import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromDbBool,
  fromDbJson,
  fromDbTimestamp,
  fromDbUuid,
  toDbBool,
  toDbJson,
  toDbTimestamp,
  toDbUuid,
  toMs,
} from '../db/codecs';

test('UUIDs round-trip through the 32-char hex storage format', () => {
  const canonical = 'a96a3f0a-8f13-472c-a16c-a4d18dbded88';
  const stored = toDbUuid(canonical);
  assert.equal(stored, 'a96a3f0a8f13472ca16ca4d18dbded88');
  assert.equal(fromDbUuid(stored), canonical);
  assert.throws(() => toDbUuid('not-a-uuid'));
});

test('timestamps use the six-digit naive-UTC SQLite shape', () => {
  const date = new Date('2026-11-12T02:28:01.710Z');
  const stored = toDbTimestamp(date);
  assert.equal(stored, '2026-11-12 02:28:01.710000');
  assert.match(stored, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u);
  assert.equal(fromDbTimestamp(stored).toISOString(), '2026-11-12T02:28:01.710Z');
  assert.equal(toMs(stored), date.getTime());
});

test('nullable JSON is stored as the literal null string', () => {
  assert.equal(toDbJson(null), 'null');
  assert.equal(toDbJson(undefined), 'null');
  assert.deepEqual(fromDbJson('null'), null);
  assert.deepEqual(fromDbJson(toDbJson({ a: 1 })), { a: 1 });
  assert.deepEqual(fromDbJson(toDbJson([])), []);
  assert.equal(fromDbJson('not json'), null);
});

test('booleans use 0/1', () => {
  assert.equal(toDbBool(true), 1);
  assert.equal(toDbBool(false), 0);
  assert.equal(fromDbBool(1), true);
  assert.equal(fromDbBool(0), false);
  assert.equal(fromDbBool(true), true);
});
