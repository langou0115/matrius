import type { WorkTerminalClientMessage, WorkTerminalServerMessage } from '@contract/work-terminals';

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const HANDSHAKE_TIMEOUT_MS = 10_000;

export type TerminalConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'missing';

export function connectWorkTerminal(
  url: string,
  onStatus: (status: TerminalConnectionStatus) => void,
  onMessage: (message: WorkTerminalServerMessage) => void,
) {
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let ready = false;
  let disposed = false;

  function handleDisconnect(code?: number) {
    clearTimeout(handshakeTimer);
    ready = false;
    socket = null;
    if (code === 4404) {
      onStatus('missing');
      return;
    }
    const delay = RETRY_DELAYS_MS[attempts];
    if (delay === undefined) {
      onStatus('disconnected');
      return;
    }
    attempts += 1;
    onStatus('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      open();
    }, delay);
  }

  function open() {
    if (disposed || socket) return;
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      handleDisconnect();
      return;
    }
    socket = current;
    handshakeTimer = setTimeout(() => {
      if (socket !== current) return;
      handleDisconnect();
      current.close();
    }, HANDSHAKE_TIMEOUT_MS);
    current.addEventListener('message', (event) => {
      if (socket !== current) return;
      let message: WorkTerminalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as WorkTerminalServerMessage;
      } catch {
        return;
      }
      if (!message || !['snapshot', 'output', 'status'].includes(message.type)) return;
      const firstStatus = !ready && message.type === 'status';
      if (firstStatus) {
        clearTimeout(handshakeTimer);
        ready = true;
        attempts = 0;
      }
      onMessage(message);
      if (firstStatus) onStatus('connected');
    });
    current.addEventListener('close', (event) => {
      if (socket === current) handleDisconnect(event.code);
    });
  }

  open();
  return {
    send(message: WorkTerminalClientMessage): boolean {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    retry() {
      if (disposed || socket) return;
      clearTimeout(retryTimer);
      attempts = 0;
      onStatus('reconnecting');
      open();
    },
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(handshakeTimer);
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
