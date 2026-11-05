import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount, createUser } from '../server/auth.ts';
import { exportBackup, loadBackup } from '../server/services/backup.ts';

let db: DB, dir: string, server: Server, base: string, cookie = '', other = '', cls: number;
async function login(email: string, password: string) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}
const call = (c: string, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-files-'));
  const holder = createHolder(join(dir, 'f.sqlite'));
  db = holder.db;
  const id = addAccount(db, 'me@example.test', 'Me', 'me-pass-123');
  createUser(db, 'other@example.test', 'Other', 'other-pass-1');
  const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'CPP', 'C++')", id).id;
  const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", id).id;
  cls = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date) VALUES (?, ?, ?, 'ASL3', '2026-09-07')", term, course, id).id;
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cookie = await login('me@example.test', 'me-pass-123');
  other = await login('other@example.test', 'other-pass-1');
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('class details and exam files', () => {
  it('saves the year, semester and promotion of a class', async () => {
    expect((await call(cookie, 'PUT', `/classes/${cls}`, { yearLevel: 2, semester: 1, promotion: '24' })).status).toBe(200);
    expect(await (await call(cookie, 'GET', `/classes/${cls}`)).json()).toMatchObject({ year_level: 2, semester: 1, promotion: '24' });
    expect((await call(cookie, 'PUT', `/classes/${cls}`, { yearLevel: 12 })).status).toBe(422);
    expect((await call(cookie, 'PUT', `/classes/${cls}`, { promotion: null })).status).toBe(200);
    expect((await (await call(cookie, 'GET', `/classes/${cls}`)).json()).promotion).toBeNull();
  });

  it('uploads, lists, downloads and deletes a paper; other teachers cannot see it; backups keep it', async () => {
    const bytes = Buffer.from('PK\u0003\u0004 fake docx bytes ' + 'x'.repeat(2000));
    const up = await fetch(`${base}/classes/${cls}/files?kind=midterm&filename=${encodeURIComponent('ASL3 Midterm ការប្រឡង.docx')}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: bytes });
    const f = await up.json();
    expect(f).toMatchObject({ kind: 'midterm', title: 'ASL3 Midterm ការប្រឡង', filename: 'ASL3 Midterm ការប្រឡង.docx', size: bytes.length });
    expect((await (await call(cookie, 'GET', `/classes/${cls}/files`)).json()).map((x: any) => x.id)).toEqual([f.id]);

    const dl = await call(cookie, 'GET', `/files/${f.id}`);
    expect(dl.headers.get('content-type')).toContain('wordprocessingml');
    expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''ASL3%20Midterm%20");
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);

    expect((await call(other, 'GET', `/files/${f.id}`)).status).toBe(404);
    expect((await call(other, 'GET', `/classes/${cls}/files`)).status).toBe(404);
    const bad = await fetch(`${base}/classes/${cls}/files?filename=evil.exe`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: bytes });
    expect(bad.status).toBe(422);

    // A JSON backup carries the file and restores it byte for byte.
    const b = JSON.parse(JSON.stringify(exportBackup(db)));
    const { db: restored } = loadBackup(b);
    expect(Buffer.from(restored.get('SELECT data FROM class_files WHERE id = ?', f.id)!.data).equals(bytes)).toBe(true);
    restored.close();

    expect((await call(cookie, 'PUT', `/files/${f.id}`, { kind: 'final', title: 'Final paper' })).status).toBe(200);
    expect((await call(cookie, 'DELETE', `/files/${f.id}`)).status).toBe(200);
    expect(await (await call(cookie, 'GET', `/classes/${cls}/files`)).json()).toEqual([]);
  });
});
