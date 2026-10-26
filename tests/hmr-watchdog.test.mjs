import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchDevelopmentServer } from '../src/core/platform/hmr-watchdog.web.ts';

/** Minimal stand-in for a WebSocket; the test decides when each one opens or dies. */
function createHarness() {
  const sockets = [];
  const createSocket = (url) => {
    const socket = {
      url, opened: false, closed: false, onopen: null, onclose: null,
      open() { socket.opened = true; socket.onopen?.(); },
      close() { socket.closed = true; },
      drop() { socket.onclose?.(); },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, createSocket };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('reloads once after the HMR socket closes and the dev server answers again', async () => {
  const { sockets, createSocket } = createHarness();
  let reloads = 0;
  const watchdog = watchDevelopmentServer({
    url: 'ws://localhost:8081/hot', createSocket, wait: () => Promise.resolve(),
    reload: () => { reloads += 1; },
  });
  const monitor = sockets[0];
  monitor.open();

  monitor.drop();
  sockets[1].drop(); // the server is still restarting
  await flush();
  assert.equal(sockets.length, 3, 'a new probe follows every failed one');

  sockets[2].open();
  await flush();
  assert.equal(reloads, 1);
  assert.equal(sockets.length, 3, 'recovery stops after the reload');

  watchdog.stop();
});

test('keeps probing while the dev server stays down instead of reloading', async () => {
  const { sockets, createSocket } = createHarness();
  let reloads = 0;
  const watchdog = watchDevelopmentServer({
    url: 'ws://localhost:8081/hot', createSocket, wait: () => Promise.resolve(),
    reload: () => { reloads += 1; },
  });

  sockets[0].drop();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    sockets[attempt].drop();
    await flush();
  }

  assert.equal(reloads, 0);
  watchdog.stop();
});

test('stop() ends recovery before a reachable server can trigger a reload', async () => {
  const { sockets, createSocket } = createHarness();
  let reloads = 0;
  const watchdog = watchDevelopmentServer({
    url: 'ws://localhost:8081/hot', createSocket, wait: () => Promise.resolve(),
    reload: () => { reloads += 1; },
  });
  const monitor = sockets[0];

  monitor.drop();
  watchdog.stop();
  sockets[1].open();
  await flush();

  assert.equal(reloads, 0);
  assert.equal(monitor.closed, true);
});

test('waits for a live generation to finish before reloading', async () => {
  const { sockets, createSocket } = createHarness();
  let reloads = 0;
  let busy = true;
  const watchdog = watchDevelopmentServer({
    url: 'ws://localhost:8081/hot', createSocket,
    wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
    canReload: () => !busy,
    reload: () => { reloads += 1; },
  });

  sockets[0].drop();
  sockets[1].open();
  await flush();
  assert.equal(reloads, 0, 'a reply is still streaming');

  busy = false;
  await flush();
  assert.equal(reloads, 1);
  watchdog.stop();
});
