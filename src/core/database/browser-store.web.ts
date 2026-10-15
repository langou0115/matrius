const DATABASE_NAME = 'matrius';
const DATABASE_VERSION = 1;
const STORE_NAME = 'state';
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

export async function readWorkspace(): Promise<StoredValue | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(WORKSPACE_KEY);
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

export async function writeWorkspace(value: unknown, expectedRevision: number): Promise<number> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(WORKSPACE_KEY);
    let conflict = false;
    request.onsuccess = () => {
      const current = request.result as StoredValue | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      store.put({ revision: expectedRevision + 1, value }, WORKSPACE_KEY);
    };
    transaction.oncomplete = () => resolve(expectedRevision + 1);
    transaction.onabort = () => reject(conflict ? new LocalDataConflict() : transaction.error ?? new Error('Cannot save local data'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Cannot save local data'));
  });
}
