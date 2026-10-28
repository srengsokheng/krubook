import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../server/db.ts';
import type { User } from '../server/auth.ts';
import { importWorkbook } from '../server/services/workbook.ts';
import { applyWorkbook, previewWorkbook } from '../server/services/merge.ts';
import { applySync } from '../server/services/records.ts';
import { buildWorkbook, type FixtureStudent } from './fixtures/workbook.ts';

process.env.KRUBOOK_TODAY = '2026-10-05';

const students = (): FixtureStudent[] => [
  { km: 'សុខ ដារ៉ា', latin: 'Sok Dara', scores: [8, 9, null, null, null, null, null] },
  { km: 'ចាន់ សុភា', latin: 'Chan Sophea', scores: [7, null, null, null, null, null, null] },
  { km: 'ហេង បូរ៉ា', latin: 'Heng Bora', scores: [6, 6, null, null, null, null, null] },
];

let db: DB, u: User;
beforeEach(async () => {
  db = new DB(':memory:');
  await importWorkbook(db, await buildWorkbook({ completedWeeks: 2, students: students() }), { today: '2026-10-05' });
  const owner = db.get('SELECT id, email, name, role FROM users')!;
  u = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
});
afterEach(() => db.close());

const score = (latin: string, key: string) => db.get(
  `SELECT x.value, x.version FROM scores x JOIN enrollments e ON e.id = x.enrollment_id JOIN students s ON s.id = e.student_id
     JOIN grade_components g ON g.id = x.component_id WHERE s.name_latin = ? AND g.key = ?`, latin, key);

describe('updating from the workbook', () => {
  it('the same workbook again changes nothing', async () => {
    const { plan } = await previewWorkbook(db, u, await buildWorkbook({ completedWeeks: 2, students: students() }));
    expect(plan.add.length + plan.update.length + plan.teach.length).toBe(0);
  });

  it('previews added and changed scores and newly taught weeks, keeps app edits, then applies exactly that', async () => {
    // A score edited in the app (now version 2) must never be overwritten by the workbook.
    const heng = db.get("SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE s.name_latin = 'Heng Bora'")!.id;
    const lab1 = db.get("SELECT id FROM grade_components WHERE key = 'lab_1'")!.id;
    expect(applySync(db, u, [{ opId: 'x', type: 'score', enrollmentId: heng, componentId: lab1, value: 5, baseVersion: 1 }])[0].status).toBe('applied');

    const next = students();
    next[0].scores[0] = 9;                // Sok Dara LAB 1: 8 → 9
    next[1].scores[1] = 7;                // Chan Sophea LAB 2: new
    next[2].scores[0] = 10;               // Heng Bora LAB 1: edited in the app, kept
    next.push({ km: 'លី លីដា', latin: 'Ly Lida', scores: [5, null, null, null, null, null, null] });
    const file = await buildWorkbook({ completedWeeks: 3, students: next });

    const { plan } = await previewWorkbook(db, u, file);
    expect(plan.update.map((c) => [c.student, c.component, c.old, c.value])).toEqual([['សុខ ដារ៉ា · Sok Dara', 'LAB 1', 8, 9]]);
    expect(plan.add.map((c) => [c.student, c.component, c.value])).toEqual([['ចាន់ សុភា · Chan Sophea', 'LAB 2', 7]]);
    expect(plan.teach.map((s) => s.date)).toEqual(['2026-09-21', '2026-09-23']);
    expect(plan.kept.editedInApp).toEqual([expect.stringContaining('Heng Bora, LAB 1: app 5, workbook 10')]);
    expect(plan.kept.students).toEqual([expect.stringContaining('Ly Lida: in the workbook, not in the app')]);
    expect(score('Sok Dara', 'lab_1')!.value).toBe(8); // preview saves nothing

    await expect(applyWorkbook(db, u, file, 'not-the-preview')).rejects.toMatchObject({ status: 409 });
    const r = await applyWorkbook(db, u, file, plan.fingerprint);
    expect(r).toMatchObject({ added: 1, updated: 1, taught: 2, failed: [] });
    expect(score('Sok Dara', 'lab_1')).toMatchObject({ value: 9, version: 2 });
    expect(score('Chan Sophea', 'lab_2')!.value).toBe(7);
    expect(score('Heng Bora', 'lab_1')!.value).toBe(5);
    expect(db.get("SELECT COUNT(*) n FROM sessions WHERE status = 'completed'")!.n).toBe(6);

    const again = (await previewWorkbook(db, u, file)).plan;
    expect(again.add.length + again.update.length + again.teach.length).toBe(0);
    await expect(applyWorkbook(db, u, file, again.fingerprint)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses files that are not the teaching workbook', async () => {
    await expect(previewWorkbook(db, u, Buffer.from('not a spreadsheet'))).rejects.toMatchObject({ status: 422 });
    const other = await (async () => { const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); wb.addWorksheet('Sheet1').addRow(['a']); return Buffer.from(await wb.xlsx.writeBuffer()); })();
    await expect(previewWorkbook(db, u, other)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Weekly Schedule') });
  });

  it('only compares the signed-in teacher’s own classes', async () => {
    const other = db.run("INSERT INTO users (email, name, password_hash) VALUES ('b@x.test', 'B', '!')").id;
    const { plan } = await previewWorkbook(db, { id: other, email: 'b@x.test', name: 'B', role: 'teacher' }, await buildWorkbook({ completedWeeks: 3, students: students() }));
    expect(plan.add.length + plan.update.length + plan.teach.length).toBe(0);
    expect(plan.kept.unmatched.length).toBeGreaterThan(0);
  });
});
