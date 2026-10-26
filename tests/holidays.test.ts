import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB } from '../server/db.ts';
import { MIGRATIONS } from '../server/schema.ts';
import { seedDemo } from '../server/seed.ts';
import { holidaysFor } from '../server/services/plan.ts';
import { cambodianHolidays, holidayRanges } from '../shared/holidays.ts';

process.env.KRUBOOK_TODAY = '2026-10-24';
let dir: string, db: DB;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'krubook-hol-')); db = new DB(join(dir, 'h.sqlite')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('holidays as single days or ranges', () => {
  it('groups the national calendar: Pchum Ben and Water Festival are one entry each', () => {
    const r = holidayRanges();
    expect(r.filter((h) => h.name === 'Pchum Ben Festival' && h.date.startsWith('2026'))).toEqual([expect.objectContaining({ date: '2026-10-10', endDate: '2026-10-12' })]);
    expect(r.filter((h) => h.name === 'Water Festival' && h.date.startsWith('2026'))).toEqual([expect.objectContaining({ date: '2026-11-23', endDate: '2026-11-25' })]);
    expect(r.find((h) => h.date === '2026-01-07')?.endDate).toBeNull();
    // Every day is still covered.
    const days = r.flatMap((h) => { const out = []; for (let d = new Date(`${h.date}T00:00:00Z`); d.toISOString().slice(0, 10) <= (h.endDate ?? h.date); d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10)); return out; });
    expect(days.sort()).toEqual(cambodianHolidays().map((h) => h.date).sort());
  });

  it('the schedule still blocks every day of a range, including the middle day', () => {
    seedDemo(db);
    const owner = db.get('SELECT id FROM users LIMIT 1')!.id, termId = db.get('SELECT id FROM terms LIMIT 1')!.id;
    expect(db.get("SELECT COUNT(*) AS n FROM holidays WHERE name = 'Water Festival' AND date LIKE '2026%'")!.n).toBe(1);
    expect(holidaysFor(db, owner, termId).filter((h) => h.name === 'Water Festival' && h.date.startsWith('2026')).map((h) => h.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
    const mid = db.all("SELECT status, note FROM sessions WHERE date = '2026-11-24'");
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.every((s) => s.status === 'cancelled' && String(s.note).startsWith('Holiday'))).toBe(true);
  });

  it('the migration merges old one-row-per-day entries and leaves separate holidays alone', () => {
    const owner = db.run("INSERT INTO users (email, name, password_hash, role) VALUES ('m@x.test', 'M', '!', 'admin')").id;
    const add = (date: string, name: string, source = 'national') => db.run('INSERT INTO holidays (owner_id, date, name, name_km, source) VALUES (?,?,?,?,?)', owner, date, name, 'km', source);
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) add(d, 'Pchum Ben Festival');
    for (const d of ['2026-12-01', '2026-12-02', '2026-12-04']) add(d, 'School break', 'user'); // gap on the 3rd: two entries
    add('2026-10-13', 'Other day');
    db.raw.exec(MIGRATIONS[3].replace('ALTER TABLE holidays ADD COLUMN end_date TEXT;', ''));
    expect(db.all('SELECT date, end_date, name FROM holidays WHERE owner_id = ? ORDER BY date', owner)).toEqual([
      { date: '2026-10-10', end_date: '2026-10-12', name: 'Pchum Ben Festival' },
      { date: '2026-10-13', end_date: null, name: 'Other day' },
      { date: '2026-12-01', end_date: '2026-12-02', name: 'School break' },
      { date: '2026-12-04', end_date: null, name: 'School break' },
    ]);
  });
});
