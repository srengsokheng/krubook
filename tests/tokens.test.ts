import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount, createUser } from '../server/auth.ts';
import { exportBackup } from '../server/services/backup.ts';

let db: DB, dir: string, server: Server, base: string, cookie = '', other = '', otherId = 0;
async function login(email: string, password: string) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const call = (c: string, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });
const withToken = (t: string, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-tokens-'));
  const holder = createHolder(join(dir, 't.sqlite'));
  db = holder.db;
  addAccount(db, 'me@example.test', 'Me', 'me-pass-123');
  otherId = createUser(db, 'other@example.test', 'Other', 'other-pass-1');
  db.run("INSERT INTO courses (owner_id, code, name) VALUES (1, 'CPP', 'C++ Programming')");
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cookie = await login('me@example.test', 'me-pass-123');
  other = await login('other@example.test', 'other-pass-1');
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('access tokens', () => {
  it('works the API as its owner, is shown once and is stored only as a hash', async () => {
    const made = await (await call(cookie, 'POST', '/account/tokens', { name: 'Claude import', days: 7 })).json();
    expect(made.token).toMatch(/^kb_[\w-]{40,}$/);
    expect(made).toMatchObject({ name: 'Claude import', active: true, ending: made.token.slice(-4) });

    const list = await (await call(cookie, 'GET', '/account/tokens')).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(JSON.stringify(db.all('SELECT * FROM api_tokens'))).not.toContain(made.token);
    expect(JSON.stringify(db.all('SELECT * FROM audit_log'))).not.toContain(made.token);

    const me = await (await withToken(made.token, 'GET', '/auth/me')).json();
    expect(me.user).toMatchObject({ email: 'me@example.test' });
    expect((await (await withToken(made.token, 'GET', '/courses')).json()).map((c: any) => c.code)).toEqual(['CPP']);
    expect((await withToken(made.token, 'POST', '/courses', { code: 'WD2', name: 'Web Development II' })).status).toBe(200);
    expect(db.get('SELECT last_used_at FROM api_tokens')!.last_used_at).not.toBeNull();

    // Someone else's data stays private.
    expect(await (await call(other, 'GET', '/courses')).json()).toEqual([]);
    expect(await (await call(other, 'GET', '/account/tokens')).json()).toEqual([]);
    expect((await call(other, 'DELETE', `/account/tokens/${made.id}`)).status).toBe(404);
  });

  it('cannot touch the account, manage accounts or restore', async () => {
    const { token } = await (await call(cookie, 'POST', '/account/tokens', { name: 'x' })).json();
    for (const [m, p] of [['GET', '/account/tokens'], ['POST', '/account/tokens'], ['POST', '/account/password'], ['GET', '/admin/accounts'], ['GET', '/admin/ai'], ['POST', '/restore'], ['GET', '/backup.json'], ['GET', '/backup.xlsx']] as const) {
      const r = await withToken(token, m, p, m === 'POST' ? { name: 'y' } : undefined);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect((await r.json()).details?.code, `${m} ${p}`).toBe('TOKEN_NOT_ALLOWED');
    }
  });

  it('stops working when revoked, expired, or the owner signs out everywhere or changes password', async () => {
    const mk = async (name: string) => (await (await call(cookie, 'POST', '/account/tokens', { name })).json());
    const a = await mk('a');
    expect((await call(cookie, 'DELETE', `/account/tokens/${a.id}`)).status).toBe(200);
    expect((await withToken(a.token, 'GET', '/courses')).status).toBe(401);

    const b = await mk('b');
    db.run("UPDATE api_tokens SET expires_at = datetime('now', '-1 minute') WHERE id = ?", b.id);
    expect((await withToken(b.token, 'GET', '/courses')).status).toBe(401);
    expect((await (await call(cookie, 'GET', '/account/tokens')).json()).find((t: any) => t.id === b.id).active).toBe(false);

    const c = await mk('c');
    expect((await call(cookie, 'POST', '/account/password', { current: 'me-pass-123', next: 'a-new-pass-456' })).status).toBe(200);
    expect((await withToken(c.token, 'GET', '/courses')).status).toBe(401);

    expect((await call(cookie, 'POST', '/account/tokens', { name: 'd', days: 91 })).status).toBe(422);
    expect((await withToken('kb_not-a-real-token-0123456789abcdef', 'GET', '/courses')).status).toBe(401);
  });

  it('is never part of a backup', async () => {
    await call(cookie, 'POST', '/account/tokens', { name: 'x' });
    expect(Object.keys(exportBackup(db).tables)).not.toContain('api_tokens');
    void otherId;
  });
});
