import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Dialog, Empty, ErrorNote, Field, Icon, Loading, Notice, Pill, ProgressPill, useAction } from '../ui.tsx';
import { weekdayName } from '../../../shared/dates.ts';

export const meetingText = (ms: any[], lang: 'en' | 'km' = 'en') => ms.map((m) => `${weekdayName(m.weekday, lang)} ${m.start_time}–${m.end_time}`).join(', ');

export function Classes() {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useApi<any[]>('/classes');
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  const list = (data ?? []).filter((c) => showArchived || c.status !== 'archived');
  const terms = [...new Set(list.map((c) => c.term_name))];
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Classes')}</h1></div>
        <div className="toolbar">
          <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />New class</button>
        </div>
      </div>
      {loading && !data ? <Loading rows={6} /> : !list.length ? (
        <div className="panel"><Empty title="No classes yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create the first class</button>}>You need a course and a term first.</Empty></div>
      ) : terms.map((term) => (
        <section key={term} className="panel">
          <div className="panel-head"><h2>{term}</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Class</th><th>Course</th><th>Starts</th><th>Meets</th><th className="num">Students</th><th>Progress</th><th>Status</th></tr></thead>
              <tbody>
                {list.filter((c) => c.term_name === term).map((c) => (
                  <tr key={c.id} className={c.status === 'archived' ? 'is-dim' : ''}>
                    <td><span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: c.color }} /><Link to={`/classes/${c.id}`} className="mono" style={{ fontWeight: 600 }}>{c.code}</Link></span>{c.name && <div className="faint xs">{c.name}</div>}</td>
                    <td>{c.course_name}</td>
                    <td className="mono small"><D date={c.start_date} /></td>
                    <td className="small">{c.meetings.length ? meetingText(c.meetings, lang) : <span className="faint">No meeting times</span>}</td>
                    <td className="num">{c.students}</td>
                    <td>{c.summary ? <ProgressPill status={c.summary.status} reason={c.summary.reason} /> : <span className="faint small">No plan yet</span>}</td>
                    <td><Pill tone={c.status === 'active' ? 'ok' : c.status === 'upcoming' ? 'accent' : undefined}>{c.status}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {creating && <CreateClass onClose={() => setCreating(false)} />}
    </div>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

export function MeetingsEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const { lang } = useI18n();
  const set = (i: number, patch: any) => onChange(value.map((m, j) => (i === j ? { ...m, ...patch } : m)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.map((m, i) => (
        <div key={i} className="meeting-row">
          <select aria-label="Weekday" value={m.weekday} onChange={(e) => set(i, { weekday: +e.target.value })}>
            {WEEKDAYS.map((d) => <option key={d} value={d}>{weekdayName(d, lang)}</option>)}
          </select>
          <input aria-label="Start time" type="time" value={m.start} onChange={(e) => set(i, { start: e.target.value })} />
          <input aria-label="End time" type="time" value={m.end} onChange={(e) => set(i, { end: e.target.value })} />
          <button className="btn ghost sm" aria-label="Remove meeting" onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="trash" /></button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...value, { weekday: 1, start: '08:00', end: '09:30' }])}><Icon name="plus" />Add meeting time</button>
    </div>
  );
}

function CreateClass({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { data: terms } = useApi<any[]>('/terms');
  const { data: courses } = useApi<any[]>('/courses');
  const [f, setF] = useState({ termId: 0, courseId: 0, code: '', name: '', startDate: '', room: '', weeks: 17 });
  const [meetings, setMeetings] = useState<any[]>([{ weekday: 1, start: '07:30', end: '09:00' }, { weekday: 3, start: '07:30', end: '09:00' }]);
  const [generate, setGenerate] = useState(true);
  const { busy, run } = useAction();
  const term = terms?.find((x) => x.id === f.termId);
  const save = () => run(async () => {
    const { id } = await api('/classes', { body: { ...f, startDate: f.startDate || term?.start_date } });
    const m = await api(`/classes/${id}/meetings`, { method: 'PUT', body: { meetings } });
    if (generate && meetings.length) await api(`/classes/${id}/plan`, { body: {} });
    return { id, warnings: m.warnings as string[] };
  }, 'Class created').then((r) => { if (r) nav(`/classes/${r.id}`); });
  return (
    <Dialog title="New class" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.termId || !f.courseId || !f.code} onClick={save}>Create class</button></>}>
      {terms && !terms.length && <Notice tone="warn">Create a term first, under Terms.</Notice>}
      <div className="form-grid">
        <Field label="Class code"><input id="c-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="ASL3" /></Field>
        <Field label="Display name (optional)"><input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Term">
          <select id="c-term" value={f.termId} onChange={(e) => setF({ ...f, termId: +e.target.value })}>
            <option value={0}>Choose…</option>
            {terms?.filter((x) => x.status !== 'archived').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Course">
          <select id="c-course" value={f.courseId} onChange={(e) => setF({ ...f, courseId: +e.target.value })}>
            <option value={0}>Choose…</option>
            {courses?.filter((x) => !x.archived).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}
          </select>
        </Field>
        <Field label="First day of class" hint={term ? `Term starts ${term.start_date}` : undefined}><input id="c-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Teaching weeks"><input id="c-weeks" type="number" min={1} max={40} value={f.weeks} onChange={(e) => setF({ ...f, weeks: +e.target.value })} /></Field>
        <Field label="Room"><input id="c-room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} /></Field>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <h3>Meeting times</h3>
        <p className="faint small">With the default rule, the first meeting of each week is the Lecture and the next is Practice. You can change the rule for this class later.</p>
        <MeetingsEditor value={meetings} onChange={setMeetings} />
      </div>
      <label className="check"><input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} /> Generate the term plan now</label>
    </Dialog>
  );
}
