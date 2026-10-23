// Offline queue for attendance and grade edits.
//
// Every edit becomes an operation keyed by its cell ("score:<enrollment>:<component>" or
// "att:<session>:<enrollment>"), stored in IndexedDB and sent to /api/sync. A later edit to the
// same cell replaces the queued one but keeps the version the first edit was based on, so the
// server can tell whether someone else changed the cell in the meantime. Conflicts are kept for
// the teacher to resolve; nothing is overwritten silently.

export type QueuedOp =
  | { key: string; opId: string; type: 'score'; enrollmentId: number; componentId: number; value: number | null; baseVersion: number | null; label: string; queuedAt: number }
  | { key: string; opId: string; type: 'attendance'; sessionId: number; enrollmentId: number; status: string | null; baseVersion: number | null; label: string; queuedAt: number };

export interface Conflict { op: QueuedOp; server: { value: unknown; version: number | null }; message: string }
export interface Failure { op: QueuedOp; message: string }

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pending: number;
  conflicts: Conflict[];
  failures: Failure[];
  lastSyncedAt: number | null;
}

type Applied = { key: string; version: number | null; op: QueuedOp };

const DB_NAME = 'krubook-offline';
let dbp: Promise<IDBDatabase | null> | null = null;
const memory = { queue: new Map<string, QueuedOp>(), conflicts: new Map<string, Conflict>(), failures: new Map<string, Failure>() };

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['queue', 'conflicts', 'failures']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function store<T>(name: 'queue' | 'conflicts' | 'failures', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const r = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAll<T>(name: 'queue' | 'conflicts' | 'failures'): Promise<T[]> {
  const db = await openDb();
  if (!db) return [...(memory[name] as Map<string, any>).values()];
  return ((await store<T[]>(name, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? []) as T[];
}
async function put(name: 'queue' | 'conflicts' | 'failures', key: string, value: unknown) {
  const db = await openDb();
  if (!db) { (memory[name] as Map<string, any>).set(key, value); return; }
  await store(name, 'readwrite', (s) => s.put(value, key));
}
async function remove(name: 'queue' | 'conflicts' | 'failures', key: string) {
  const db = await openDb();
  if (!db) { memory[name].delete(key); return; }
  await store(name, 'readwrite', (s) => s.delete(key));
}
async function getOne<T>(name: 'queue', key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return memory.queue.get(key) as T | undefined;
  return store<T>(name, 'readonly', (s) => s.get(key) as IDBRequest<T>);
}

// ---------------------------------------------------------------------------------------------

let state: SyncState = { online: typeof navigator === 'undefined' ? true : navigator.onLine, syncing: false, pending: 0, conflicts: [], failures: [], lastSyncedAt: null };
const listeners = new Set<(s: SyncState) => void>();
const appliedListeners = new Set<(a: Applied[]) => void>();

function emit(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function subscribe(fn: (s: SyncState) => void) {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

export function onApplied(fn: (a: Applied[]) => void) {
  appliedListeners.add(fn);
  return () => { appliedListeners.delete(fn); };
}

async function refreshCounts() {
  const [q, c, f] = await Promise.all([getAll<QueuedOp>('queue'), getAll<Conflict>('conflicts'), getAll<Failure>('failures')]);
  emit({ pending: q.length, conflicts: c, failures: f });
}

export async function pendingOps(): Promise<QueuedOp[]> {
  return getAll<QueuedOp>('queue');
}

type NewOp = Omit<Extract<QueuedOp, { type: 'score' }>, 'key' | 'opId' | 'queuedAt'> | Omit<Extract<QueuedOp, { type: 'attendance' }>, 'key' | 'opId' | 'queuedAt'>;

export function cellKey(op: { type: string; enrollmentId: number; componentId?: number; sessionId?: number }) {
  return op.type === 'score' ? `score:${op.enrollmentId}:${op.componentId}` : `att:${op.sessionId}:${op.enrollmentId}`;
}

export async function enqueue(ops: NewOp[]) {
  for (const op of ops) {
    const key = cellKey(op as any);
    const existing = await getOne<QueuedOp>('queue', key);
    const full = { ...op, key, opId: `${key}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, queuedAt: Date.now(), baseVersion: existing ? existing.baseVersion : op.baseVersion } as QueuedOp;
    await put('queue', key, full);
    await remove('failures', key);
  }
  await refreshCounts();
  void flush();
}

let flushing: Promise<void> | null = null;

export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!navigator.onLine) { emit({ online: false }); return; }
      const ops = (await getAll<QueuedOp>('queue')).sort((a, b) => a.queuedAt - b.queuedAt);
      if (!ops.length) { emit({ online: true }); return; }
      emit({ syncing: true });
      for (let i = 0; i < ops.length; i += 500) {
        const batch = ops.slice(i, i + 500);
        const res = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ops: batch.map(({ key: _k, label: _l, queuedAt: _q, ...rest }) => rest) }),
        });
        if (!res.ok) {
          if (res.status === 401) window.dispatchEvent(new CustomEvent('krubook:signed-out'));
          throw new Error(`sync ${res.status}`);
        }
        const { results } = await res.json();
        const applied: Applied[] = [];
        for (const r of results) {
          const op = batch.find((o) => o.opId === r.opId);
          if (!op) continue;
          // Only clear the queue entry if no newer edit replaced it while we were sending.
          const current = await getOne<QueuedOp>('queue', op.key);
          const superseded = current && current.opId !== op.opId;
          if (r.status === 'applied') {
            if (superseded) await put('queue', op.key, { ...current!, baseVersion: r.version });
            else await remove('queue', op.key);
            applied.push({ key: op.key, version: r.version, op });
          } else if (r.status === 'conflict') {
            if (!superseded) await remove('queue', op.key);
            await put('conflicts', op.key, { op, server: r.server, message: r.message });
          } else {
            if (!superseded) await remove('queue', op.key);
            await put('failures', op.key, { op, message: r.message });
          }
        }
        if (applied.length) for (const l of appliedListeners) l(applied);
      }
      emit({ online: true, lastSyncedAt: Date.now() });
    } catch {
      emit({ online: navigator.onLine });
    } finally {
      emit({ syncing: false });
      await refreshCounts();
      flushing = null;
    }
  })();
  return flushing;
}

export async function resolveConflict(key: string, choice: 'mine' | 'server') {
  const c = (await getAll<Conflict>('conflicts')).find((x) => x.op.key === key);
  if (!c) return;
  await remove('conflicts', key);
  if (choice === 'mine') await put('queue', key, { ...c.op, baseVersion: c.server.version, opId: `${key}:${Date.now()}`, queuedAt: Date.now() });
  await refreshCounts();
  void flush();
}

export async function dismissFailure(key: string) {
  await remove('failures', key);
  await refreshCounts();
}

export function startSync() {
  window.addEventListener('online', () => { emit({ online: true }); void flush(); });
  window.addEventListener('offline', () => emit({ online: false }));
  setInterval(() => { void flush(); }, 30000);
  void refreshCounts().then(() => flush());
}
