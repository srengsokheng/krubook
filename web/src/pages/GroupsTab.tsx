import { useMemo, useState } from 'react';
import { api, useApi } from '../api.ts';
import { Confirm, Dialog, Empty, ErrorNote, Field, Icon, Loading, Menu, Notice, Pill, useAction } from '../ui.tsx';

// Groups for group work (midterm, final project…): one list of groups per piece of work. Each group
// has a topic and exam paper; the group score is given to every member and each member can get an
// individual score on top. When the list is linked to a gradebook column, group + individual is
// written there. Search finds a group by its name, topic, exam or any member's ID or name.

type Student = { enrollmentId: number; code: string; nameKm: string | null; nameLatin: string | null };
type Member = Student & { active: boolean; individualScore: number | null; mark: number | null };
type Group = { id: number; name: string; topic: string | null; exam: string | null; note: string | null; groupScore: number | null; members: Member[] };
type Column = { id: number; name: string; max: number; groupMax: number; individualMax: number; finalized: boolean };
type GroupSet = { id: number; name: string; column: Column | null; groups: Group[]; unassigned: number[] };
type Data = { students: Student[]; columns: { id: number; name: string; max: number }[]; sets: GroupSet[] };

const who = (s: Student) => s.nameLatin || s.nameKm || s.code;
const fmt = (n: number | null | undefined) => (n == null ? '' : String(n));

export function GroupsTab({ cls }: { cls: any }) {
  const { data, error, loading, reload } = useApi<Data>(`/classes/${cls.id}/groups`);
  const [pick, setPick] = useState<number | null>(null);
  const [editSet, setEditSet] = useState<Partial<GroupSet> & { componentId?: number | null; groupMax?: number | null } | null>(null);
  const [query, setQuery] = useState('');
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={5} />;
  if (!data) return null;
  const set = data.sets.find((s) => s.id === pick) ?? data.sets[data.sets.length - 1] ?? null;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Groups</h2>
          <div className="row">
            {data.sets.length > 0 && (
              <select aria-label="Group list" value={set?.id ?? ''} onChange={(e) => setPick(Number(e.target.value))}>
                {data.sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <button className="btn primary" onClick={() => setEditSet({ name: '', componentId: null, groupMax: null })}><Icon name="plus" />New group list</button>
          </div>
        </div>
        {!set ? (
          <Empty title="No groups yet">Make a group list for each piece of group work, e.g. “Final project”. Link it to a gradebook column to give each student the group score plus their own score there.</Empty>
        ) : (
          <SetHeader set={set} onEdit={() => setEditSet({ ...set, componentId: set.column?.id ?? null, groupMax: set.column?.groupMax ?? null })} reload={reload} />
        )}
      </section>
      {set && (
        <>
          <div className="row">
            <div className="search" style={{ flex: 1 }}><Icon name="search" /><input aria-label="Search groups" placeholder="Search group, topic, exam, or a student’s ID or name" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            <AddGroup set={set} reload={reload} />
          </div>
          <Unassigned set={set} students={data.students} />
          <GroupList set={set} students={data.students} query={query} reload={reload} />
        </>
      )}
      {editSet && <SetForm cls={cls} set={editSet} columns={data.columns} onClose={() => setEditSet(null)} onSaved={(id) => { setPick(id); reload(); }} />}
    </div>
  );
}

function SetHeader({ set, onEdit, reload }: { set: GroupSet; onEdit: () => void; reload: () => void }) {
  const [del, setDel] = useState(false);
  const { run } = useAction();
  const members = set.groups.reduce((n, g) => n + g.members.length, 0);
  return (
    <div className="panel-body row" style={{ justifyContent: 'space-between' }}>
      <span className="small">
        <b>{set.name}</b> · {set.groups.length} groups · {members} students in groups{set.unassigned.length ? ` · ${set.unassigned.length} not in a group` : ''}
        <div className="faint xs">
          {set.column
            ? <>Marks go to the gradebook column <b>{set.column.name}</b> (/{set.column.max}): group score out of {set.column.groupMax}{set.column.individualMax > 0 ? ` + individual score out of ${set.column.individualMax}` : ''}.</>
            : 'Not linked to a gradebook column: scores are kept here only.'}
          {set.column?.finalized && ' The gradebook is finalized, so marks cannot change.'}
        </div>
      </span>
      <Menu items={[{ label: 'Edit list…', onSelect: onEdit }, { label: 'Delete list…', danger: true, onSelect: () => setDel(true) }]} />
      {del && <Confirm title={`Delete “${set.name}”?`} body="The groups are removed. Marks already in the gradebook stay." confirmLabel="Delete" danger onConfirm={() => run(() => api(`/group-sets/${set.id}`, { method: 'DELETE' }), 'Group list deleted').then(reload)} onClose={() => setDel(false)} />}
    </div>
  );
}

function SetForm({ cls, set, columns, onClose, onSaved }: { cls: any; set: any; columns: Data['columns']; onClose: () => void; onSaved: (id: number) => void }) {
  const [f, setF] = useState({ name: set.name ?? '', componentId: set.componentId ? String(set.componentId) : '', groupMax: set.groupMax != null ? String(set.groupMax) : '' });
  const { busy, run } = useAction();
  const column = columns.find((c) => String(c.id) === f.componentId);
  const save = () => run(async () => {
    const body = { name: f.name, componentId: f.componentId ? Number(f.componentId) : null, groupMax: f.componentId ? (f.groupMax === '' ? null : Number(f.groupMax)) : null };
    if (set.id) { await api(`/group-sets/${set.id}`, { method: 'PUT', body }); return set.id as number; }
    return (await api<{ id: number }>(`/classes/${cls.id}/group-sets`, { body })).id;
  }, 'Saved').then((id) => { if (id) { onSaved(id); onClose(); } });
  return (
    <Dialog title={set.id ? 'Edit group list' : 'New group list'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => void save()}>Save</button></>}>
      <div className="stack">
        <Field label="Name"><input id="gs-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Final project" /></Field>
        <Field label="Gradebook column (optional)" hint="Each member's mark there becomes group score + individual score.">
          <select id="gs-column" value={f.componentId} onChange={(e) => setF({ ...f, componentId: e.target.value })}>
            <option value="">Not linked</option>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name} (/{c.max})</option>)}
          </select>
        </Field>
        {column && (
          <Field label={`Group part, out of ${column.max}`} hint={`The rest (${column.max} minus this) is the individual part. Leave empty to make the whole mark the group score.`}>
            <input id="gs-groupmax" type="number" min={0} max={column.max} step="0.5" value={f.groupMax} onChange={(e) => setF({ ...f, groupMax: e.target.value })} placeholder={String(column.max)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function AddGroup({ set, reload }: { set: GroupSet; reload: () => void }) {
  const [split, setSplit] = useState(false);
  const [size, setSize] = useState('4');
  const [order, setOrder] = useState<'id' | 'random'>('id');
  const { busy, run } = useAction();
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => run(() => api(`/group-sets/${set.id}/groups`, { body: {} }), 'Group added').then(reload)}><Icon name="plus" />Add group</button>
      {set.unassigned.length > 0 && <button className="btn" onClick={() => setSplit(true)}>Make groups automatically…</button>}
      {split && (
        <Dialog title="Make groups automatically" onClose={() => setSplit(false)}
          footer={<><button className="btn" onClick={() => setSplit(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api(`/group-sets/${set.id}/split`, { body: { size: Number(size), order } }), 'Groups made').then((r) => { if (r) { setSplit(false); reload(); } })}>Make groups</button></>}>
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>Puts the {set.unassigned.length} students not yet in a group into new groups. You can move anyone afterwards.</p>
            <div className="form-grid">
              <Field label="Students per group"><input id="split-size" type="number" min={1} max={50} value={size} onChange={(e) => setSize(e.target.value)} /></Field>
              <Field label="Order"><select id="split-order" value={order} onChange={(e) => setOrder(e.target.value as 'id' | 'random')}><option value="id">By student ID</option><option value="random">Random</option></select></Field>
            </div>
            {Number(size) > 0 && <p className="faint xs" style={{ margin: 0 }}>About {Math.max(1, Math.round(set.unassigned.length / Number(size)))} groups.</p>}
          </div>
        </Dialog>
      )}
    </>
  );
}

function Unassigned({ set, students }: { set: GroupSet; students: Student[] }) {
  const [open, setOpen] = useState(false);
  if (!set.unassigned.length) return null;
  const list = students.filter((s) => set.unassigned.includes(s.enrollmentId));
  return (
    <Notice tone="warn">
      {list.length} student{list.length === 1 ? ' is' : 's are'} not in a group yet.{' '}
      <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      {open && <div className="small" style={{ marginTop: 6 }}>{list.map((s) => `${s.code} ${who(s)}`).join(' · ')}</div>}
    </Notice>
  );
}

function GroupList({ set, students, query, reload }: { set: GroupSet; students: Student[]; query: string; reload: () => void }) {
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => set.groups.filter((g) => !q
    || [g.name, g.topic, g.exam, g.note].some((x) => (x ?? '').toLowerCase().includes(q))
    || g.members.some((m) => m.code.toLowerCase().includes(q) || (m.nameLatin ?? '').toLowerCase().includes(q) || (m.nameKm ?? '').includes(query.trim()))), [set.groups, q, query]);
  if (!set.groups.length) return <Empty title="No groups in this list">Add groups one by one, or make them automatically from the class list.</Empty>;
  if (!shown.length) return <Empty title="No group matches">Try a group name, topic, or a student’s ID or name.</Empty>;
  return <div className="stack">{shown.map((g) => <GroupCard key={g.id} group={g} set={set} students={students} query={q} reload={reload} />)}</div>;
}

function GroupCard({ group, set, students, query, reload }: { group: Group; set: GroupSet; students: Student[]; query: string; reload: () => void }) {
  const [info, setInfo] = useState({ name: group.name, topic: group.topic ?? '', exam: group.exam ?? '' });
  const [gs, setGs] = useState(fmt(group.groupScore));
  const [ind, setInd] = useState<Record<number, string>>(Object.fromEntries(group.members.map((m) => [m.enrollmentId, fmt(m.individualScore)])));
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState(false);
  const { busy, run } = useAction();
  const col = set.column;
  const infoDirty = info.name !== group.name || info.topic !== (group.topic ?? '') || info.exam !== (group.exam ?? '');
  const scoresDirty = gs !== fmt(group.groupScore) || group.members.some((m) => (ind[m.enrollmentId] ?? '') !== fmt(m.individualScore));
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const total = (m: Member) => { const a = num(gs), b = num(ind[m.enrollmentId] ?? ''); return a == null && b == null ? null : Math.round(((a ?? 0) + (b ?? 0)) * 100) / 100; };
  const saveInfo = () => run(() => api(`/groups/${group.id}`, { method: 'PUT', body: info }), 'Group saved').then(reload);
  const saveScores = () => run(() => api(`/groups/${group.id}/scores`, { method: 'PUT', body: { groupScore: num(gs), individual: Object.fromEntries(group.members.map((m) => [m.enrollmentId, num(ind[m.enrollmentId] ?? '')])) } }),
    col ? `Marks saved to ${col.name}` : 'Scores saved').then(reload);
  const hit = (m: Member) => !!query && (m.code.toLowerCase().includes(query) || (m.nameLatin ?? '').toLowerCase().includes(query) || (m.nameKm ?? '').includes(query));

  return (
    <section className="panel" aria-label={group.name}>
      <div className="panel-head">
        <h2 style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{group.name} <span className="faint small">{group.members.length} students</span></h2>
        <Menu items={[{ label: 'Add students…', onSelect: () => setAdding(true) }, { label: 'Delete group…', danger: true, onSelect: () => setDel(true) }]} />
      </div>
      <div className="panel-body stack">
        <div className="form-grid">
          <Field label="Group name"><input aria-label={`Name of ${group.name}`} value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></Field>
          <Field label="Topic"><input aria-label={`Topic of ${group.name}`} value={info.topic} onChange={(e) => setInfo({ ...info, topic: e.target.value })} placeholder="e.g. Library management system" /></Field>
          <Field label="Exam / paper"><input aria-label={`Exam of ${group.name}`} value={info.exam} onChange={(e) => setInfo({ ...info, exam: e.target.value })} placeholder="e.g. Paper B" /></Field>
        </div>
        {infoDirty && <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !info.name.trim()} onClick={() => void saveInfo()}>Save group details</button>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Student</th><th className="num">Group{col ? ` /${col.groupMax}` : ''}</th><th className="num">Individual{col && col.individualMax > 0 ? ` /${col.individualMax}` : ''}</th><th className="num">{col ? `${col.name} /${col.max}` : 'Total'}</th><th /></tr></thead>
            <tbody>
              {group.members.map((m, i) => (
                <tr key={m.enrollmentId} className={hit(m) ? 'marker' : m.active ? '' : 'is-dim'}>
                  <td><span className="mono small">{m.code}</span> {who(m)}{m.nameKm && m.nameLatin && <div className="faint xs">{m.nameKm}</div>}{!m.active && <Pill tone="warn">left the class</Pill>}</td>
                  <td className="num">{i === 0
                    ? <input aria-label={`Group score of ${group.name}`} type="number" min={0} max={col?.groupMax} step="0.25" style={{ width: 80 }} value={gs} onChange={(e) => setGs(e.target.value)} disabled={col?.finalized} />
                    : <span className="faint">{gs || '–'}</span>}</td>
                  <td className="num">{col && col.individualMax === 0 ? <span className="faint">–</span>
                    : <input aria-label={`Individual score of ${m.code}`} type="number" min={0} max={col?.individualMax} step="0.25" style={{ width: 80 }} value={ind[m.enrollmentId] ?? ''} onChange={(e) => setInd({ ...ind, [m.enrollmentId]: e.target.value })} disabled={col?.finalized} />}</td>
                  <td className="num"><b>{fmt(total(m)) || '–'}</b>{col && m.mark != null && m.mark !== total(m) && !scoresDirty && <div className="faint xs">gradebook: {m.mark}</div>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm ghost" aria-label={`Remove ${m.code} from ${group.name}`} onClick={() => run(() => api(`/groups/${group.id}/members/${m.enrollmentId}`, { method: 'DELETE' })).then(reload)}><Icon name="x" /></button></td>
                </tr>
              ))}
              {!group.members.length && <tr><td colSpan={5} className="faint small">No students yet. Use “Add students…”.</td></tr>}
            </tbody>
          </table>
        </div>
        {group.members.length > 0 && (
          <div className="row">
            <button className="btn primary" disabled={busy || !scoresDirty || col?.finalized} onClick={() => void saveScores()}>{col ? `Save marks to ${col.name}` : 'Save scores'}</button>
            <span className="faint xs">The group score counts for every member{col && col.individualMax > 0 ? '; each member’s individual score is added to it' : ''}.</span>
          </div>
        )}
      </div>
      {adding && <AddMembers group={group} set={set} students={students} onClose={() => setAdding(false)} onDone={reload} />}
      {del && <Confirm title={`Delete ${group.name}?`} body="Its students become ungrouped. Marks already in the gradebook stay." confirmLabel="Delete" danger onConfirm={() => run(() => api(`/groups/${group.id}`, { method: 'DELETE' }), 'Group deleted').then(reload)} onClose={() => setDel(false)} />}
    </section>
  );
}

function AddMembers({ group, set, students, onClose, onDone }: { group: Group; set: GroupSet; students: Student[]; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const { busy, run } = useAction();
  const groupOf = new Map(set.groups.flatMap((g) => g.members.map((m) => [m.enrollmentId, g] as const)));
  const list = students.filter((s) => groupOf.get(s.enrollmentId)?.id !== group.id)
    .filter((s) => !q.trim() || s.code.includes(q.trim()) || (s.nameLatin ?? '').toLowerCase().includes(q.trim().toLowerCase()) || (s.nameKm ?? '').includes(q.trim()))
    .sort((a, b) => Number(groupOf.has(a.enrollmentId)) - Number(groupOf.has(b.enrollmentId)) || a.code.localeCompare(b.code));
  return (
    <Dialog title={`Add students to ${group.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !chosen.length} onClick={() => run(() => api(`/groups/${group.id}/members`, { body: { enrollmentIds: chosen } }), `${chosen.length} added`).then((r) => { if (r !== undefined) { onDone(); onClose(); } })}>Add {chosen.length || ''}</button></>}>
      <div className="stack">
        <div className="search"><Icon name="search" /><input aria-label="Find students" placeholder="ID or name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          {list.map((s) => {
            const other = groupOf.get(s.enrollmentId);
            return (
              <label key={s.enrollmentId} className="row small" style={{ padding: '4px 0' }}>
                <input type="checkbox" checked={chosen.includes(s.enrollmentId)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.enrollmentId] : chosen.filter((x) => x !== s.enrollmentId))} />
                <span className="mono">{s.code}</span> {who(s)}{other && <span className="faint xs">(in {other.name}, will move)</span>}
              </label>
            );
          })}
          {!list.length && <p className="faint small">No students match.</p>}
        </div>
      </div>
    </Dialog>
  );
}
