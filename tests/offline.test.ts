import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncState } from '../web/src/offline.ts';

// The offline queue falls back to memory when IndexedDB is unavailable (as in Node), which keeps
// the queueing, coalescing and conflict logic testable without a browser.
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });

const q = await import('../web/src/offline.ts');
let state: SyncState;
q.subscribe((s) => { state = s; });

const op = (value: number | null, baseVersion: number | null) => ({ type: 'score' as const, enrollmentId: 1, componentId: 2, value, baseVersion, label: 'test' });

describe('offline queue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps edits while offline and coalesces repeated edits to one cell', async () => {
    await q.enqueue([op(3, 4)]);
    await q.enqueue([op(4.5, 5)]);
    const ops = await q.pendingOps();
    expect(ops).toHaveLength(1);
    // The latest value is sent, based on the version seen before the first offline edit.
    expect(ops[0]).toMatchObject({ value: 4.5, baseVersion: 4 });
    expect(state.pending).toBe(1);
  });

  it('turns a server conflict into a decision for the teacher, and "use mine" re-sends on the new version', async () => {
    (navigator as any).onLine = true;
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const results = body.ops.map((o: any) => (o.baseVersion === 4 ? { opId: o.opId, status: 'conflict', server: { value: 2, version: 6 }, message: 'changed' } : { opId: o.opId, status: 'applied', version: 7 }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }));
    await q.flush();
    expect(state.conflicts).toHaveLength(1);
    expect(state.pending).toBe(0);
    await q.resolveConflict('score:1:2', 'mine');
    await q.flush();
    expect(calls.at(-1).ops[0]).toMatchObject({ value: 4.5, baseVersion: 6 });
    expect(state.conflicts).toHaveLength(0);
    expect(state.pending).toBe(0);
  });

  it('reports rejected edits instead of dropping them silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => new Response(JSON.stringify({ results: JSON.parse(init.body).ops.map((o: any) => ({ opId: o.opId, status: 'error', message: 'Score 9 is above the maximum of 5.' })) }))));
    await q.enqueue([op(9, null)]);
    await q.flush();
    expect(state.failures[0].message).toMatch(/above the maximum/);
  });
});
