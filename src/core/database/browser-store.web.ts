import type { WorkspaceData } from '@/features/workspace/workspace-repository.web';
import type { Message } from '@/features/chat/chat-state';

const DATABASE_NAME = 'matrius';
const DATABASE_VERSION = 2;
const STORE_NAME = 'state';
const MESSAGE_STORE = 'messages';
const WORKSPACE_KEY = 'workspace';
let connection: Promise<IDBDatabase> | undefined;

export class LocalDataConflict extends Error {
  constructor() { super('Local data changed in another page'); }
}

type StoredValue = { revision: number; value: unknown };

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      // v2: store message bodies separately for incremental streaming writes.
      if (!request.result.objectStoreNames.contains(MESSAGE_STORE)) request.result.createObjectStore(MESSAGE_STORE);
    };
    request.onblocked = () => { rejected = true; reject(new Error('Database upgrade blocked')); };
    request.onerror = () => reject(request.error ?? new Error('Cannot open local database'));
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) { database.close(); return; }
      database.onversionchange = () => { database.close(); connection = undefined; };
      resolve(database);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}

export async function readLocalValue(key: string): Promise<StoredValue | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    transaction.oncomplete = () => {
      const record: unknown = request.result;
      if (record === undefined) { resolve(null); return; }
      if (!record || typeof record !== 'object' || !('revision' in record) || !('value' in record) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
        reject(new Error('Invalid local database record')); return;
      }
      resolve({ revision: Number(record.revision), value: record.value });
    };
    transaction.onabort = () => reject(transaction.error ?? new Error('Cannot read local data'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Cannot read local data'));
  });
}

export async function writeLocalValue(key: string, value: unknown, expectedRevision: number): Promise<number> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    let conflict = false;
    request.onsuccess = () => {
      const current = request.result as StoredValue | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      store.put({ revision: expectedRevision + 1, value }, key);
    };
    transaction.oncomplete = () => resolve(expectedRevision + 1);
    transaction.onabort = () => reject(conflict ? new LocalDataConflict() : transaction.error ?? new Error('Cannot save local data'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Cannot save local data'));
  });
}

// Metadata and changed message bodies commit together under the workspace revision.
// Legacy v1 snapshots are read as-is, and converted atomically on the next save.
type WorkspaceMetadata = Omit<WorkspaceData, 'chat'> & {
  chat: Omit<WorkspaceData['chat'], 'conversations'> & {
    conversations: (Omit<WorkspaceData['chat']['conversations'][number], 'messages'> & { messageKeys: string[] })[];
  };
};
const messageKey = (conversationId: string, id: string) => JSON.stringify([conversationId, id]);

export async function readWorkspace(): Promise<StoredValue | null> {
  const stored = await readLocalValue(WORKSPACE_KEY);
  if (!stored || !stored.value || typeof stored.value !== 'object' || !('storageVersion' in stored.value)) return stored;
  if (stored.value.storageVersion !== 2) throw new Error('Unsupported local storage version');
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME, MESSAGE_STORE], 'readonly');
    const metaRequest = transaction.objectStore(STORE_NAME).get(WORKSPACE_KEY);
    let value: WorkspaceData;
    let revision: number;
    metaRequest.onsuccess = () => {
      try {
        const record = metaRequest.result as StoredValue;
        revision = record.revision;
        const metadata = (record.value as { data: WorkspaceMetadata }).data;
        value = { ...metadata, chat: { ...metadata.chat, conversations: metadata.chat.conversations.map(({ messageKeys, ...conversation }) => {
          const messages: Message[] = new Array(messageKeys.length);
          messageKeys.forEach((key, index) => {
            const request = transaction.objectStore(MESSAGE_STORE).get(key);
            request.onsuccess = () => { messages[index] = request.result; };
          });
          return { ...conversation, messages };
        }) } };
      } catch { transaction.abort(); }
    };
    transaction.oncomplete = () => resolve({ revision, value });
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Cannot read messages'));
  });
}

export async function writeWorkspace(value: WorkspaceData, expectedRevision: number): Promise<number> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME, MESSAGE_STORE], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const messages = transaction.objectStore(MESSAGE_STORE);
    const request = store.get(WORKSPACE_KEY);
    let conflict = false;
    request.onsuccess = () => {
      const current = request.result as StoredValue | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) { conflict = true; transaction.abort(); return; }
      const keys = new Set<string>();
      const metadata: WorkspaceMetadata = { ...value, chat: { ...value.chat, conversations: value.chat.conversations.map(({ messages: bodies, ...conversation }) => {
        const messageKeys = bodies.map((message) => {
          const key = messageKey(conversation.id, message.id);
          keys.add(key);
          const existing = messages.get(key);
          existing.onsuccess = () => {
            if (JSON.stringify(existing.result) !== JSON.stringify(message)) messages.put(message, key);
          };
          return key;
        });
        return { ...conversation, messageKeys };
      }) } };
      const existingKeys = messages.getAllKeys();
      existingKeys.onsuccess = () => {
        for (const key of existingKeys.result) if (!keys.has(String(key))) messages.delete(key);
      };
      store.put({ revision: expectedRevision + 1, value: { storageVersion: 2, data: metadata } }, WORKSPACE_KEY);
    };
    transaction.oncomplete = () => resolve(expectedRevision + 1);
    transaction.onabort = () => reject(conflict ? new LocalDataConflict() : transaction.error ?? new Error('Cannot save messages'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Cannot save messages'));
  });
}
