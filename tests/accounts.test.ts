import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount } from '../server/auth.ts';

process.env.KRUBOOK_TODAY = '2026-11-01';

let db: DB, dir: string, server: Server, base: string;
type Client = { cookie: string };
async function call(c: Client | null, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(c ? { cookie: c.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function login(email: string, password: string): Promise<Client & { status: number; body: any }> {
  const r = await call(null, 'POST', '/auth/login', { email, password });
  return { cookie: r.cookie ?? '', status: r.status, body: r.body };
}
let admin: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-acc-'));
  const holder = createHolder(join(dir, 'a.sqlite'));
  db = holder.db;
  addAccount(db, 'owner@example.test', 'Owner', 'owner-pass-1');
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  admin = await login('owner@example.test', 'owner-pass-1');
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

/** An admin-created teacher who has chosen their own password. */
async function teacher(email = 'dara@example.test', extra: object = {}) {
  const made = await call(admin, 'POST', '/admin/accounts', { email, name: 'Dara', ...extra });
  expect(made.status).toBe(200);
  const first = await login(email, made.body.temporaryPassword);
  expect(first.body.user.mustChangePassword).toBe(true);
  expect((await call(first, 'POST', '/account/password', { current: made.body.temporaryPassword, next: 'dara-own-pass' })).status).toBe(200);
  return { ...first, id: made.body.account.id as number };
}

describe('accounts', () => {
  it('an admin creates a teacher, who must choose a password before doing anything', async () => {
    const made = await call(admin, 'POST', '/admin/accounts', { email: 'dara@example.test', name: 'Dara', accessUntil: '2026-12-31' });
    expect(made.body.temporaryPassword).toMatch(/^[a-z]+-\d{4}-[a-z]+$/);
    expect(made.body.account).toMatchObject({ role: 'teacher', status: 'active', accessUntil: '2026-12-31', mustChangePassword: true });
    expect(db.get('SELECT COUNT(*) AS n FROM holidays WHERE owner_id = ?', made.body.account.id)!.n).toBeGreaterThan(5);

    const t = await login('dara@example.test', made.body.temporaryPassword);
    expect((await call(t, 'GET', '/classes')).body).toMatchObject({ details: { code: 'PASSWORD_CHANGE_REQUIRED' } });
    expect((await call(t, 'POST', '/account/password', { current: 'wrong', next: 'dara-own-pass' })).status).toBe(422);
    expect((await call(t, 'POST', '/account/password', { current: made.body.temporaryPassword, next: 'dara-own-pass' })).status).toBe(200);
    expect((await call(t, 'GET', '/classes')).status).toBe(200);
    expect((await login('dara@example.test', 'dara-own-pass')).status).toBe(200);
    // Teachers cannot manage accounts.
    expect((await call(t, 'GET', '/admin/accounts')).status).toBe(403);
    expect((await call(t, 'POST', '/admin/accounts', { email: 'x@example.test', name: 'X' })).status).toBe(403);
  });

  it('each teacher sees only their own data, and so does the admin', async () => {
    const t = await teacher();
    const course = (await call(t, 'POST', '/courses', { code: 'CPP', name: 'C++' })).body.id;
    expect(course).toBeGreaterThan(0);
    expect((await call(t, 'GET', '/courses')).body.map((c: any) => c.id)).toEqual([course]);
    expect((await call(admin, 'GET', '/courses')).body).toEqual([]);
    expect((await call(admin, 'GET', `/courses/${course}`)).status).toBe(404);
    expect((await call(admin, 'PUT', `/courses/${course}`, { name: 'Taken' })).status).toBe(404);
    // The admin's list shows counts only.
    const row = (await call(admin, 'GET', '/admin/accounts')).body.accounts.find((a: any) => a.id === t.id);
    expect(row).toMatchObject({ email: 'dara@example.test', counts: { classes: 0, students: 0 } });
  });

  it('after the paid-until date a teacher can look but not change anything', async () => {
    const t = await teacher('dara@example.test', { accessUntil: '2026-11-01' });
    expect((await call(t, 'POST', '/courses', { code: 'A', name: 'A' })).status).toBe(200); // last day still works
    await call(admin, 'PUT', `/admin/accounts/${t.id}`, { accessUntil: '2026-10-31' });
    const me = (await call(t, 'GET', '/auth/me')).body.user;
    expect(me).toMatchObject({ expired: true, accessUntil: '2026-10-31' });
    expect((await call(t, 'GET', '/courses')).status).toBe(200);
    const refused = await call(t, 'POST', '/courses', { code: 'B', name: 'B' });
    expect(refused).toMatchObject({ status: 403, body: { details: { code: 'ACCESS_EXPIRED' } } });
    // Renewing restores changes at once.
    await call(admin, 'PUT', `/admin/accounts/${t.id}`, { accessUntil: '2027-01-31' });
    expect((await call(t, 'POST', '/courses', { code: 'B', name: 'B' })).status).toBe(200);
  });

  it('a feature switched off is refused for that account only', async () => {
    const t = await teacher('dara@example.test', { featuresOff: ['pay'] });
    expect((await call(t, 'GET', '/pay?year=2026')).body).toMatchObject({ details: { code: 'FEATURE_OFF', feature: 'pay' } });
    expect((await call(t, 'GET', '/auth/me')).body.user.featuresOff).toEqual(['pay']);
    expect((await call(admin, 'GET', '/pay?year=2026')).status).toBe(200);
    await call(admin, 'PUT', `/admin/accounts/${t.id}`, { featuresOff: [] });
    expect((await call(t, 'GET', '/pay?year=2026')).status).toBe(200);
    expect((await call(admin, 'PUT', `/admin/accounts/${t.id}`, { featuresOff: ['nonsense'] })).status).toBe(422);
  });

  it('suspending signs the teacher out and blocks sign-in; a password reset forces a new password', async () => {
    const t = await teacher();
    await call(admin, 'PUT', `/admin/accounts/${t.id}`, { status: 'suspended' });
    expect((await call(t, 'GET', '/classes')).status).toBe(401);
    expect((await login('dara@example.test', 'dara-own-pass')).status).toBe(403);
    await call(admin, 'PUT', `/admin/accounts/${t.id}`, { status: 'active' });
    const reset = (await call(admin, 'POST', `/admin/accounts/${t.id}/reset-password`)).body.temporaryPassword;
    expect((await login('dara@example.test', 'dara-own-pass')).status).toBe(401);
    expect((await login('dara@example.test', reset)).body.user.mustChangePassword).toBe(true);
  });

  it('protects the last administrator and keeps accounts that have data', async () => {
    const me = (await call(admin, 'GET', '/auth/me')).body.user.id;
    expect((await call(admin, 'PUT', `/admin/accounts/${me}`, { status: 'suspended' })).status).toBe(409);
    expect((await call(admin, 'PUT', `/admin/accounts/${me}`, { role: 'teacher' })).status).toBe(409);
    expect((await call(admin, 'DELETE', `/admin/accounts/${me}`)).status).toBe(409);
    const t = await teacher();
    await call(t, 'POST', '/courses', { code: 'CPP', name: 'C++' });
    expect((await call(admin, 'DELETE', `/admin/accounts/${t.id}`)).status).toBe(409);
    const empty = await call(admin, 'POST', '/admin/accounts', { email: 'tmp@example.test', name: 'Tmp' });
    expect((await call(admin, 'DELETE', `/admin/accounts/${empty.body.account.id}`)).status).toBe(200);
    expect(db.get('SELECT 1 FROM users WHERE id = ?', empty.body.account.id)).toBeUndefined();
    expect((await call(admin, 'POST', '/admin/accounts', { email: 'dara@example.test', name: 'Again' })).status).toBe(409);
  });
});
