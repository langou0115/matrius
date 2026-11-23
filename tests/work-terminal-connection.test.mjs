import assert from 'node:assert/strict';
import test from 'node:test';

import { connectWorkTerminal } from '../ui/features/work/work-terminal-connection.ts';

function mockSockets(t) {
  const sockets = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent = [];

    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }

    message(message) {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }

    close(code = 1006) {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
  }
  t.mock.property(globalThis, 'WebSocket', FakeSocket);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return sockets;
}

test('reconnects to the same terminal and only sends input after the new snapshot and status', (t) => {
  const sockets = mockSockets(t);
  const statuses = [];
  const messages = [];
  const url = 'ws://localhost/api/work/terminals/session-1/ws';
  const connection = connectWorkTerminal(url, (status) => statuses.push(status), (message) => messages.push(message));
  t.after(connection.dispose);
  const running = { type: 'status', status: 'running', exitCode: null };
  const input = { type: 'input', data: 'echo hello\r' };
  sockets[0].message(running);
  assert.equal(connection.send(input), true);
  sockets[0].close();
  assert.equal(connection.send(input), false);
  t.mock.timers.tick(500);
  assert.equal(sockets[1].url, url);
  const snapshot = { type: 'snapshot', data: 'output while disconnected' };
  sockets[1].message(snapshot);
  assert.equal(connection.send(input), false);
  sockets[1].message(running);
  sockets[0].message({ type: 'output', data: 'stale' });
  assert.deepEqual(statuses, ['connected', 'reconnecting', 'connected']);
  assert.deepEqual(messages, [running, snapshot, running]);
  assert.deepEqual(sockets[1].sent, []);
  assert.equal(connection.send(input), true);
  assert.deepEqual(sockets[1].sent, [input]);
});

test('bounds retries, supports manual retry, and stops on a missing terminal or disposal', (t) => {
  const sockets = mockSockets(t);
  const statuses = [];
  const connection = connectWorkTerminal('ws://localhost/terminal', (status) => statuses.push(status), () => {});
  t.after(connection.dispose);

  t.mock.timers.tick(10_000);
  assert.equal(sockets[0].readyState, 3);
  for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
    t.mock.timers.tick(delay);
    sockets.at(-1).close();
  }
  assert.equal(sockets.length, 6);
  assert.equal(statuses.at(-1), 'disconnected');
  connection.retry();
  assert.equal(sockets.length, 7);
  sockets.at(-1).close(4404);
  assert.equal(statuses.at(-1), 'missing');
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 7);

  connection.retry();
  sockets.at(-1).close();
  connection.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 8);
});
