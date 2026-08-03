'use client';

// The offline queue. IndexedDB, because the far pasture has no signal and a
// capture that lives only in React state is a capture that dies when the
// handset locks.
//
// CONTRACT
//  · A capture is written to IndexedDB BEFORE any network call is attempted.
//    Sync is a background chore, never a precondition for finishing the job.
//  · Photos are stored as Blobs in the same record, so the queue survives a
//    reload with the picture intact.
//  · `localId` is the idempotency key. Re-sending an entry that already landed
//    is a no-op upstream, so a flaky truck-stop connection cannot duplicate a
//    device.
//  · Nothing is deleted on success — synced entries stay visible until the
//    installer clears them, because "did that one go through" is the question
//    they will actually ask.
import type { DraftInstall, QueuedInstall } from './types';

const DB_NAME = 'overwatch-install';
const DB_VERSION = 1;
const STORE = 'queue';
const CONTEXT_STORE = 'context';

interface StoredRecord extends QueuedInstall {
  photo: Blob | null;
  photoName: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'draft.localId' });
      }
      if (!db.objectStoreNames.contains(CONTEXT_STORE)) {
        db.createObjectStore(CONTEXT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open.'));
  });
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = work(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('That write did not stick.'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function enqueue(
  draft: DraftInstall,
  photo: File | null,
): Promise<QueuedInstall> {
  const record: StoredRecord = {
    draft,
    state: 'queued',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    photoStatus: photo ? 'pending' : 'none',
    photoError: null,
    photo: photo ?? null,
    photoName: photo?.name ?? null,
  };
  await run(STORE, 'readwrite', (store) => store.put(record));
  return stripBlob(record);
}

export async function listQueue(): Promise<QueuedInstall[]> {
  const records = await run<StoredRecord[]>(STORE, 'readonly', (store) => store.getAll());
  return records
    .map(stripBlob)
    .sort((a, b) => b.draft.capturedAt.localeCompare(a.draft.capturedAt));
}

async function get(localId: string): Promise<StoredRecord | undefined> {
  return run<StoredRecord | undefined>(STORE, 'readonly', (store) => store.get(localId));
}

async function put(record: StoredRecord): Promise<void> {
  await run(STORE, 'readwrite', (store) => store.put(record));
}

export async function remove(localId: string): Promise<void> {
  await run(STORE, 'readwrite', (store) => store.delete(localId));
}

export async function clearSynced(): Promise<void> {
  const records = await run<StoredRecord[]>(STORE, 'readonly', (store) => store.getAll());
  for (const record of records) {
    if (record.state === 'synced') await remove(record.draft.localId);
  }
}

function stripBlob(record: StoredRecord): QueuedInstall {
  const { photo: _photo, photoName: _photoName, ...rest } = record;
  void _photo;
  void _photoName;
  return rest;
}

export interface FlushResult {
  attempted: number;
  synced: number;
  failed: number;
}

/**
 * Push everything that has not landed. Runs one entry at a time on purpose:
 * a truck cresting a hill gets a few seconds of signal, and serial requests
 * over one connection beat a burst that all time out together.
 */
export async function flush(): Promise<FlushResult> {
  const records = await run<StoredRecord[]>(STORE, 'readonly', (store) => store.getAll());
  const pending = records.filter((record) => record.state !== 'synced');
  const result: FlushResult = { attempted: pending.length, synced: 0, failed: 0 };

  for (const record of pending) {
    const fresh = await get(record.draft.localId);
    if (!fresh || fresh.state === 'synced') continue;

    await put({ ...fresh, state: 'syncing' });

    try {
      const body = new FormData();
      body.set('draft', JSON.stringify(fresh.draft));
      if (fresh.photo) body.set('photo', fresh.photo, fresh.photoName ?? 'install.jpg');

      const response = await fetch('/admin/install/sync', { method: 'POST', body });
      const payload = (await response.json()) as {
        ok: boolean;
        message: string;
        photoUploaded?: boolean;
        photoError?: string;
      };

      if (!response.ok || !payload.ok) {
        await put({
          ...fresh,
          state: 'failed',
          attempts: fresh.attempts + 1,
          lastError: payload.message || `Sync failed (${response.status}).`,
        });
        result.failed += 1;
        continue;
      }

      await put({
        ...fresh,
        state: 'synced',
        attempts: fresh.attempts + 1,
        lastError: null,
        syncedAt: new Date().toISOString(),
        photoStatus: fresh.photo ? (payload.photoUploaded ? 'uploaded' : 'failed') : 'none',
        photoError: payload.photoError ?? null,
      });
      result.synced += 1;
    } catch (cause) {
      // Offline again. Not an error worth shouting about — put it back.
      await put({
        ...fresh,
        state: 'queued',
        attempts: fresh.attempts + 1,
        lastError: cause instanceof Error ? cause.message : 'No connection.',
      });
      result.failed += 1;
    }
  }

  return result;
}

// ── cached context (farms + features), so a cold reload works with no signal ──

const CONTEXT_KEY = 'context';

export async function saveContext(value: unknown): Promise<void> {
  await run(CONTEXT_STORE, 'readwrite', (store) => store.put(value, CONTEXT_KEY));
}

export async function loadContext<T>(): Promise<T | null> {
  const value = await run<T | undefined>(CONTEXT_STORE, 'readonly', (store) =>
    store.get(CONTEXT_KEY),
  );
  return value ?? null;
}
