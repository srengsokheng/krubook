import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../server/db.ts';
import { addAccount, createUser, type User } from '../server/auth.ts';
import { runDataFixes } from '../server/fixes.ts';
import { cancelSession } from '../server/services/plan.ts';
import { approveMonth, payLines } from '../server/services/pay.ts';

process.env.KRUBOOK_TODAY = '2026-11-04';

let db: DB, u: User, cls: number;
const session = (date: string, start: string, end: string) => db.run(
  "INSERT INTO sessions (class_id, week, date, start_time, end_time, kind, status, original_date) VALUES (?, 1, ?, ?, ?, 'lecture', 'planned', ?)", cls, date, start, end, date,
).id;
const checkin = (id: number) => db.get('SELECT time, source FROM checkins WHERE session_id = ?', id);
const status = (id: number) => db.get('SELECT status FROM sessions WHERE id = ?', id)!.status;

beforeEach(() => {
  db = new DB(':memory:');
  const id = addAccount(db, 'owner@example.test', 'Owner', 'owner-pass-1');
  u = { id, email: 'owner@example.test', name: 'Owner', role: 'admin' };
  const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'C', 'C')", id).id;
  const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", id).id;
  cls = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date, status) VALUES (?, ?, ?, 'SY33', '2026-09-01', 'active')", term, course, id).id;
  db.run("INSERT INTO rates (owner_id, mode, amount, effective_from) VALUES (?, 'hourly', 9, '2026-01-01')", id);
});
afterEach(() => { db.close(); delete process.env.KRUBOOK_NOW_TIME; });

describe('data fix 2026-11-04: attended since 16 Oct, one late arrival', () => {
  it('records past classes as taught and checked in on time, except 24 Oct 13:00 at 13:35; runs once', () => {
    const before = session('2026-10-15', '13:00', '14:30');   // previous pay month: untouched
    const a = session('2026-10-19', '13:00', '14:30');
    const late = session('2026-10-24', '13:00', '14:30');
    const holiday = session('2026-10-29', '13:00', '14:30');
    cancelSession(db, u, holiday, 'Holiday: Coronation Day');
    const morning = session('2026-11-04', '07:30', '09:00');   // today, already over
    const evening = session('2026-11-04', '17:00', '18:30');   // today, not yet
    const future = session('2026-11-05', '13:00', '14:30');
    process.env.KRUBOOK_NOW_TIME = '12:00';

    runDataFixes(db);
    expect([a, late, morning].map(status)).toEqual(['completed', 'completed', 'completed']);
    expect(checkin(a)).toEqual({ time: '13:00', source: 'manual' });
    expect(checkin(late)).toEqual({ time: '13:35', source: 'manual' });
    expect(checkin(morning)!.time).toBe('07:30');
    for (const id of [before, holiday, evening, future]) expect(checkin(id)).toBeUndefined();
    expect([before, evening, future].map(status)).toEqual(['planned', 'planned', 'planned']);
    expect(status(holiday)).toBe('cancelled');
    expect(JSON.parse(db.get("SELECT result FROM data_fixes")!.result)).toMatchObject({ recorded: 3, checkedIn: 3, late: 1, failed: [] });

    // Pay: the late class is unpaid (35 min >= 30), the others in full ($13.50 each).
    const lines = payLines(db, u, '2026-10-16', '2026-11-15');
    expect(lines.map((l) => [l.date, l.late, l.amount])).toEqual([['2026-10-19', 0, 13.5], ['2026-10-24', 35, 0], ['2026-11-04', 0, 13.5]]);

    // A second start changes nothing.
    db.run('DELETE FROM checkins WHERE session_id = ?', a);
    runDataFixes(db);
    expect(checkin(a)).toBeUndefined();
  });

  it('leaves approved months and existing check-ins alone', () => {
    const done = session('2026-10-19', '13:00', '14:30');
    const mine = session('2026-10-20', '13:00', '14:30');
    db.run("INSERT INTO checkins (session_id, time, source) VALUES (?, '13:05', 'tap')", mine);
    // Approve November first: both classes (one recorded, one checked in) are then locked.
    db.run("INSERT INTO teaching_records (session_id, taught_on, minutes) VALUES (?, '2026-10-19', 90)", done);
    db.run("UPDATE sessions SET status = 'completed' WHERE id = ?", done);
    approveMonth(db, u, '2026-11');
    runDataFixes(db);
    expect(checkin(done)).toBeUndefined();
    expect(checkin(mine)).toEqual({ time: '13:05', source: 'tap' });
    expect(JSON.parse(db.get("SELECT result FROM data_fixes")!.result)).toMatchObject({ locked: 2, alreadyCheckedIn: 0 });
  });

  it('does nothing when it cannot tell whose classes these are', () => {
    const other = createUser(db, 'second@example.test', 'Second', 'second-pass-1', 'admin');
    const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", other).id;
    const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'C', 'C')", other).id;
    db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date) VALUES (?, ?, ?, 'X', '2026-09-01')", term, course, other);
    const a = session('2026-10-19', '13:00', '14:30');
    runDataFixes(db);
    expect(checkin(a)).toBeUndefined();
    expect(JSON.parse(db.get("SELECT result FROM data_fixes")!.result)).toEqual({ skipped: 'no single administrator with classes' });
  });
});

describe('holidays and pay', () => {
  it('a class on a holiday is not paid, even if recorded as taught, unless marked or checked in', async () => {
    const { payOverview, payslip } = await import('../server/services/pay.ts');
    process.env.KRUBOOK_TODAY = '2026-10-20';
    try {
      const taughtOnHoliday = session('2026-10-13', '13:00', '14:30');
      const exception = session('2026-10-14', '13:00', '14:30');
      const checked = session('2026-10-09', '13:00', '14:30');
      const normal = session('2026-10-08', '13:00', '14:30');
      for (const id of [taughtOnHoliday, exception, normal]) {
        db.run("INSERT INTO teaching_records (session_id, taught_on, minutes) VALUES (?, (SELECT date FROM sessions WHERE id = ?), 90)", id, id);
        db.run("UPDATE sessions SET status = 'completed' WHERE id = ?", id);
      }
      db.run('UPDATE sessions SET holiday_exception = 1 WHERE id = ?', exception);
      db.run("INSERT INTO checkins (session_id, time, source) VALUES (?, '13:00', 'manual')", checked);
      db.run("INSERT INTO holidays (owner_id, date, end_date, name, source) VALUES (?, '2026-10-09', '2026-10-15', 'Pchum Ben Festival', 'user')", u.id);

      expect(payLines(db, u, '2026-09-16', '2026-10-15').map((l) => l.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-14']);
      const oct = payOverview(db, u, '2026').months.find((m) => m.month === '2026-10')!;
      expect(oct).toMatchObject({ scheduledSessions: 3, scheduledPay: 40.5, total: 40.5, taughtSessions: 3 });
      const slip = payslip(db, u, '2026-10');
      expect(slip.rows.find((r: any) => r.sessionId === taughtOnHoliday)).toMatchObject({ state: 'not held', reason: 'Holiday: Pchum Ben Festival (recorded as taught, not paid)', amount: 0 });
    } finally { process.env.KRUBOOK_TODAY = '2026-11-04'; }
  });

  it('the attendance fix leaves classes on holidays alone', () => {
    db.run("INSERT INTO holidays (owner_id, date, name, source) VALUES (?, '2026-10-27', 'Closed', 'user')", u.id);
    const closed = session('2026-10-27', '13:00', '14:30');
    process.env.KRUBOOK_NOW_TIME = '12:00';
    runDataFixes(db);
    expect(checkin(closed)).toBeUndefined();
    expect(status(closed)).toBe('planned');
    expect(JSON.parse(db.get("SELECT result FROM data_fixes")!.result)).toMatchObject({ holiday: 1 });
  });
});

describe('pay breakdown', () => {
  it('goes from the full timetable to Actual: holidays, cancelled, late, not recorded, to come, adjustments', async () => {
    const { payOverview, payslip } = await import('../server/services/pay.ts');
    process.env.KRUBOOK_TODAY = '2026-11-04';
    const taught = (id: number) => { db.run("INSERT INTO teaching_records (session_id, taught_on, minutes) VALUES (?, (SELECT date FROM sessions WHERE id = ?), 90)", id, id); db.run("UPDATE sessions SET status = 'completed' WHERE id = ?", id); };
    taught(session('2026-10-19', '13:00', '14:30'));                       // worked      13.50
    const late = session('2026-10-24', '13:00', '14:30'); taught(late);     // worked, 35 min late: cut 13.50
    db.run("INSERT INTO checkins (session_id, time, source) VALUES (?, '13:35', 'manual')", late);
    taught(session('2026-10-27', '13:00', '14:30'));                       // on a holiday added later
    db.run("INSERT INTO holidays (owner_id, date, name, source) VALUES (?, '2026-10-27', 'School closed', 'user')", u.id);
    cancelSession(db, u, session('2026-10-29', '13:00', '14:30'), 'Holiday: King Norodom Sihamoni’s Coronation Day');
    cancelSession(db, u, session('2026-10-30', '13:00', '14:30'), 'Teacher sick');
    session('2026-11-02', '13:00', '14:30');                               // past, not recorded
    session('2026-11-10', '13:00', '14:30');                               // still to come
    db.run("INSERT INTO pay_adjustments (owner_id, month, amount, note) VALUES (?, '2026-11', 5, 'Invigilation')", u.id);

    const m = payOverview(db, u, '2026').months.find((x) => x.month === '2026-11')!;
    expect(m.breakdown).toEqual({
      timetable: { sessions: 7, minutes: 630, pay: 94.5 },
      holidays: [
        { name: 'School closed', sessions: 1, minutes: 90, pay: 13.5 },
        { name: 'King Norodom Sihamoni’s Coronation Day', sessions: 1, minutes: 90, pay: 13.5 },
      ],
      cancelled: { sessions: 1, pay: 13.5 },
      lateCuts: { sessions: 1, pay: 13.5 },
      notRecorded: { sessions: 1, pay: 13.5 },
      toGo: { sessions: 1, pay: 13.5 },
      adjustments: 5,
      other: 0,
      actual: 18.5,
    });
    expect(m).toMatchObject({ total: 18.5, holidayPay: 27 });
    expect(payslip(db, u, '2026-11').breakdown).toEqual(m.breakdown);
  });
});
