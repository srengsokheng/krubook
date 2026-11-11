import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass } from './access.ts';
import { applySync } from './records.ts';
import { validateScore } from '../../shared/grades.ts';

// Student groups for group work. A class has one "group set" per piece of group work (e.g. the
// final project); each set has groups with a topic and exam paper, and every active student is in
// at most one group of a set. A set can be linked to a gradebook column: then each member's mark in
// that column is the group score (shared by the group, out of `group_max`) plus the member's own
// individual score (out of the rest of the column's maximum). Marks are written through the
// gradebook's normal save path, so its checks, history and finalization rules apply.

const r2 = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);

function ownSet(db: DB, u: User, id: number): Row {
  const s = db.get('SELECT * FROM group_sets WHERE id = ?', id);
  if (!s) throw new AppError(404, 'Group list not found.');
  ownClass(db, u, s.class_id);
  return s;
}

function ownGroup(db: DB, u: User, id: number): { group: Row; set: Row } {
  const g = db.get('SELECT * FROM student_groups WHERE id = ?', id);
  if (!g) throw new AppError(404, 'Group not found.');
  return { group: g, set: ownSet(db, u, g.set_id) };
}

/** The linked column and how its maximum splits into a group part and an individual part. */
function columnOf(db: DB, set: Row) {
  if (!set.component_id) return null;
  const c = db.get("SELECT c.id, c.name, c.max_score, c.kind, gc.class_id, gc.status FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = ?", set.component_id);
  if (!c || c.class_id !== set.class_id) return null;
  const groupMax = set.group_max == null ? c.max_score : Math.min(set.group_max, c.max_score);
  return { id: c.id as number, name: c.name as string, max: c.max_score as number, groupMax, individualMax: r2(c.max_score - groupMax), finalized: c.status === 'finalized' };
}

function checkColumn(db: DB, classId: number, componentId: unknown, groupMax: unknown) {
  if (componentId == null || componentId === '') return { componentId: null, groupMax: null };
  const c = db.get("SELECT c.id, c.max_score, c.kind, gc.class_id FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = ?", Number(componentId));
  if (!c || c.class_id !== classId) throw new AppError(422, 'Choose a gradebook column of this class.');
  if (c.kind !== 'manual') throw new AppError(422, 'The attendance column is calculated; choose another column.');
  const gm = groupMax == null || groupMax === '' ? c.max_score : Number(groupMax);
  if (!Number.isFinite(gm) || gm < 0 || gm > c.max_score) throw new AppError(422, `The group part must be between 0 and ${c.max_score}, the column's maximum.`);
  return { componentId: c.id as number, groupMax: r2(gm) };
}

/** Every group list of a class, with groups, members and their current gradebook marks. */
export function listSets(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  const students = db.all(
    `SELECT e.id AS enrollment_id, s.student_code, s.name_km, s.name_latin FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.class_id = ? AND e.status = 'active' ORDER BY s.student_code`, classId,
  ).map((s) => ({ enrollmentId: s.enrollment_id, code: s.student_code, nameKm: s.name_km, nameLatin: s.name_latin }));
  const columns = db.all(
    `SELECT c.id, c.name, c.max_score FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE gc.class_id = ? AND c.kind = 'manual' ORDER BY c.position, c.id`, classId,
  ).map((c) => ({ id: c.id, name: c.name, max: c.max_score }));
  const sets = db.all('SELECT * FROM group_sets WHERE class_id = ? ORDER BY created_at, id', classId).map((set) => {
    const column = columnOf(db, set);
    const marks = new Map<number, number>(column ? db.all('SELECT enrollment_id, value FROM scores WHERE component_id = ?', column.id).map((r) => [r.enrollment_id, r.value]) : []);
    const groups = db.all('SELECT * FROM student_groups WHERE set_id = ? ORDER BY position, id', set.id).map((g) => ({
      id: g.id, name: g.name, topic: g.topic, exam: g.exam, note: g.note, groupScore: g.group_score,
      members: db.all(
        `SELECT m.enrollment_id, m.individual_score, s.student_code, s.name_km, s.name_latin, e.status FROM group_members m
           JOIN enrollments e ON e.id = m.enrollment_id JOIN students s ON s.id = e.student_id WHERE m.group_id = ? ORDER BY s.student_code`, g.id,
      ).map((m) => ({
        enrollmentId: m.enrollment_id, code: m.student_code, nameKm: m.name_km, nameLatin: m.name_latin, active: m.status === 'active',
        individualScore: m.individual_score, mark: marks.get(m.enrollment_id) ?? null,
      })),
    }));
    const placed = new Set(groups.flatMap((g) => g.members.map((m) => m.enrollmentId)));
    return { id: set.id, name: set.name, column, groups, unassigned: students.filter((s) => !placed.has(s.enrollmentId)).map((s) => s.enrollmentId) };
  });
  return { students, columns, sets };
}

export function createSet(db: DB, u: User, classId: number, b: Row) {
  ownClass(db, u, classId);
  const name = text(b.name, 80);
  if (!name) throw new AppError(422, 'Name the group list, e.g. “Final project”.');
  const col = checkColumn(db, classId, b.componentId, b.groupMax);
  return db.tx(() => {
    const id = db.run('INSERT INTO group_sets (class_id, name, component_id, group_max) VALUES (?,?,?,?)', classId, name, col.componentId, col.groupMax).id;
    db.audit(u.id, 'group_set', id, 'create', undefined, { classId, name, ...col });
    return { id };
  });
}

export function updateSet(db: DB, u: User, id: number, b: Row) {
  const set = ownSet(db, u, id);
  const name = b.name === undefined ? set.name : text(b.name, 80);
  if (!name) throw new AppError(422, 'Name the group list.');
  const col = b.componentId === undefined && b.groupMax === undefined
    ? { componentId: set.component_id, groupMax: set.group_max }
    : checkColumn(db, set.class_id, b.componentId === undefined ? set.component_id : b.componentId, b.groupMax === undefined ? set.group_max : b.groupMax);
  db.tx(() => {
    db.run('UPDATE group_sets SET name = ?, component_id = ?, group_max = ? WHERE id = ?', name, col.componentId, col.groupMax, set.id);
    db.audit(u.id, 'group_set', set.id, 'update', { name: set.name, componentId: set.component_id, groupMax: set.group_max }, { name, ...col });
  });
}

/** Deletes the groups; marks already written to the gradebook stay. */
export function deleteSet(db: DB, u: User, id: number) {
  const set = ownSet(db, u, id);
  db.tx(() => { db.run('DELETE FROM group_sets WHERE id = ?', set.id); db.audit(u.id, 'group_set', set.id, 'delete', { name: set.name }); });
}

export function createGroup(db: DB, u: User, setId: number, b: Row) {
  const set = ownSet(db, u, setId);
  const n = (db.get('SELECT COUNT(*) AS n FROM student_groups WHERE set_id = ?', set.id)!.n as number) + 1;
  const name = text(b.name, 80) ?? `Group ${n}`;
  return db.tx(() => {
    const id = db.run('INSERT INTO student_groups (set_id, position, name, topic, exam, note) VALUES (?,?,?,?,?,?)', set.id, n, name, text(b.topic, 300), text(b.exam, 200), text(b.note, 1000)).id;
    if (Array.isArray(b.enrollmentIds)) placeMembers(db, set, id, b.enrollmentIds);
    db.audit(u.id, 'group', id, 'create', undefined, { setId: set.id, name });
    return { id };
  });
}

export function updateGroup(db: DB, u: User, id: number, b: Row) {
  const { group } = ownGroup(db, u, id);
  const pick = (k: string, max: number) => (b[k] === undefined ? group[k] : text(b[k], max));
  const name = b.name === undefined ? group.name : text(b.name, 80);
  if (!name) throw new AppError(422, 'Give the group a name.');
  db.tx(() => {
    db.run('UPDATE student_groups SET name = ?, topic = ?, exam = ?, note = ? WHERE id = ?', name, pick('topic', 300), pick('exam', 200), pick('note', 1000), group.id);
    db.audit(u.id, 'group', group.id, 'update', { name: group.name, topic: group.topic, exam: group.exam }, { name, topic: pick('topic', 300), exam: pick('exam', 200) });
  });
}

export function deleteGroup(db: DB, u: User, id: number) {
  const { group } = ownGroup(db, u, id);
  db.tx(() => { db.run('DELETE FROM student_groups WHERE id = ?', group.id); db.audit(u.id, 'group', group.id, 'delete', { name: group.name }); });
}

/** Puts students in a group, moving them out of any other group of the same list. */
function placeMembers(db: DB, set: Row, groupId: number, ids: unknown[]) {
  for (const raw of ids) {
    const eid = Number(raw);
    const e = db.get('SELECT id, class_id FROM enrollments WHERE id = ?', eid);
    if (!e || e.class_id !== set.class_id) throw new AppError(422, 'A chosen student is not in this class.');
    const cur = db.get('SELECT id, group_id FROM group_members WHERE set_id = ? AND enrollment_id = ?', set.id, eid);
    if (cur?.group_id === groupId) continue;
    // A student who changes group keeps no individual score from the old one.
    if (cur) db.run('UPDATE group_members SET group_id = ?, individual_score = NULL WHERE id = ?', groupId, cur.id);
    else db.run('INSERT INTO group_members (set_id, group_id, enrollment_id) VALUES (?,?,?)', set.id, groupId, eid);
  }
}

export function addMembers(db: DB, u: User, groupId: number, ids: unknown) {
  const { group, set } = ownGroup(db, u, groupId);
  if (!Array.isArray(ids) || !ids.length) throw new AppError(422, 'Choose at least one student.');
  db.tx(() => { placeMembers(db, set, group.id, ids); db.audit(u.id, 'group', group.id, 'members.add', undefined, { enrollmentIds: ids }); });
}

export function removeMember(db: DB, u: User, groupId: number, enrollmentId: number) {
  const { group } = ownGroup(db, u, groupId);
  db.tx(() => {
    db.run('DELETE FROM group_members WHERE group_id = ? AND enrollment_id = ?', group.id, enrollmentId);
    db.audit(u.id, 'group', group.id, 'members.remove', { enrollmentId });
  });
}

/**
 * Splits the students not yet in a group into new groups of `size` (the last ones join earlier
 * groups rather than form a group much smaller than the rest), in ID order or shuffled.
 */
export function splitUnassigned(db: DB, u: User, setId: number, b: Row) {
  const set = ownSet(db, u, setId);
  const size = Math.trunc(Number(b.size));
  if (!(size >= 1 && size <= 50)) throw new AppError(422, 'Choose a group size from 1 to 50.');
  const free = db.all(
    `SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.class_id = ? AND e.status = 'active' AND e.id NOT IN (SELECT enrollment_id FROM group_members WHERE set_id = ?) ORDER BY s.student_code`,
    set.class_id, set.id,
  ).map((r) => r.id as number);
  if (!free.length) throw new AppError(422, 'Every student is already in a group.');
  if (b.order === 'random') for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [free[i], free[j]] = [free[j]!, free[i]!]; }
  const count = Math.max(1, Math.round(free.length / size));
  const chunks: number[][] = Array.from({ length: count }, () => []);
  free.forEach((id, i) => chunks[i % count]!.push(id));
  let n = db.get('SELECT COUNT(*) AS n FROM student_groups WHERE set_id = ?', set.id)!.n as number;
  return db.tx(() => {
    for (const chunk of chunks) {
      n++;
      const gid = db.run('INSERT INTO student_groups (set_id, position, name) VALUES (?,?,?)', set.id, n, `Group ${n}`).id;
      placeMembers(db, set, gid, chunk);
    }
    db.audit(u.id, 'group_set', set.id, 'split', undefined, { size, order: b.order === 'random' ? 'random' : 'id', groups: count, students: free.length });
    return { groups: count, students: free.length };
  });
}

/**
 * Saves a group's scores: the group score (shared by every member) and each member's individual
 * score. When the list is linked to a gradebook column, each member's mark there becomes
 * group + individual (cleared when both are empty), through the gradebook's own save path.
 */
export function saveScores(db: DB, u: User, groupId: number, b: Row) {
  const { group, set } = ownGroup(db, u, groupId);
  const col = columnOf(db, set);
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const groupScore = b.groupScore === undefined ? group.group_score : num(b.groupScore);
  const individual: Record<string, unknown> = b.individual && typeof b.individual === 'object' ? b.individual : {};
  if (col?.finalized) throw new AppError(409, 'This gradebook is finalized, so marks cannot change.');
  if (groupScore !== null) {
    const err = validateScore(groupScore, col ? col.groupMax : Number.MAX_SAFE_INTEGER);
    if (err) throw new AppError(422, `Group score: ${err}`);
  }
  const members = db.all('SELECT * FROM group_members WHERE group_id = ?', group.id);
  const next = new Map<number, number | null>(members.map((m) => [m.enrollment_id, m.individual_score]));
  for (const [k, v] of Object.entries(individual)) {
    const eid = Number(k);
    if (!next.has(eid)) throw new AppError(422, 'A score was given for a student who is not in this group.');
    const val = num(v);
    if (val !== null) {
      const err = validateScore(val, col ? col.individualMax : Number.MAX_SAFE_INTEGER);
      if (err) throw new AppError(422, `Individual score: ${err}`);
    }
    next.set(eid, val);
  }
  return db.tx(() => {
    db.run('UPDATE student_groups SET group_score = ? WHERE id = ?', groupScore, group.id);
    for (const [eid, val] of next) db.run('UPDATE group_members SET individual_score = ? WHERE group_id = ? AND enrollment_id = ?', val, group.id, eid);
    db.audit(u.id, 'group', group.id, 'scores', { groupScore: group.group_score }, { groupScore, individual });
    if (!col) return { written: 0 };
    const active = new Set(db.all("SELECT id FROM enrollments WHERE class_id = ? AND status = 'active'", set.class_id).map((r) => r.id as number));
    const ops = [...next].filter(([eid]) => active.has(eid)).map(([eid, ind]) => {
      const cur = db.get('SELECT version FROM scores WHERE enrollment_id = ? AND component_id = ?', eid, col.id);
      const value = groupScore === null && ind === null ? null : r2((groupScore ?? 0) + (ind ?? 0));
      return { type: 'score' as const, opId: `group:${group.id}:${eid}`, enrollmentId: eid, componentId: col.id, value, baseVersion: cur?.version ?? null };
    });
    const results = applySync(db, u, ops);
    const failed = results.filter((r) => r.status !== 'applied');
    if (failed.length) throw new AppError(422, `Marks were not saved: ${'message' in failed[0]! ? failed[0].message : 'a mark changed meanwhile'}.`);
    return { written: ops.length };
  });
}

/** Group of each student for one list, for the gradebook's group filter. */
export function membership(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  return db.all(
    `SELECT gs.id AS set_id, gs.name AS set_name, g.id AS group_id, g.name AS group_name, g.topic, m.enrollment_id
       FROM group_sets gs JOIN student_groups g ON g.set_id = gs.id JOIN group_members m ON m.group_id = g.id
      WHERE gs.class_id = ? ORDER BY gs.created_at, gs.id, g.position, g.id`, classId,
  );
}
