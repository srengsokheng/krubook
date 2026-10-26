import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Confirm, D, Dialog, Empty, ErrorNote, Field, Icon, Loading, Notice, Pill, useAction } from '../ui.tsx';
import { ProposalReview } from '../Proposal.tsx';

export function Terms() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<any[]>('/terms');
  const [form, setForm] = useState<any | null>(null);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Terms')}</h1></div>
        <button className="btn primary" onClick={() => setForm({})}><Icon name="plus" />New term</button>
      </div>
      {loading && !data ? <Loading /> : !data?.length ? <div className="panel"><Empty title="No terms yet" action={<button className="btn primary" onClick={() => setForm({})}>Create a term</button>} /></div> : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Term</th><th>Dates</th><th>Midterm</th><th>Final</th><th className="num">Classes</th><th>Status</th></tr></thead>
            <tbody>{data.map((x) => (
              <tr key={x.id} className={x.status === 'archived' ? 'is-dim' : ''}>
                <td><Link to={`/terms/${x.id}`}>{x.name}</Link></td>
                <td className="mono small"><D date={x.start_date} year /> – <D date={x.end_date} year /></td>
                <td className="mono small">{x.midterm_start ? <><D date={x.midterm_start} /> – <D date={x.midterm_end} /></> : '—'}</td>
                <td className="mono small">{x.final_start ? <><D date={x.final_start} /> – <D date={x.final_end} /></> : '—'}</td>
                <td className="num">{x.classes}</td>
                <td><Pill tone={x.status === 'active' ? 'ok' : x.status === 'upcoming' ? 'accent' : undefined}>{x.status}</Pill></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {form && <TermForm term={form.id ? form : null} onClose={() => setForm(null)} onDone={reload} />}
    </div>
  );
}

function TermForm({ term, clone, onClose, onDone }: { term: any | null; clone?: boolean; onClose: () => void; onDone: (id?: number) => void }) {
  const [f, setF] = useState({
    name: clone ? `${term.name} (copy)` : term?.name ?? '', startDate: clone ? '' : term?.start_date ?? '', endDate: clone ? '' : term?.end_date ?? '',
    midtermStart: clone ? '' : term?.midterm_start ?? '', midtermEnd: clone ? '' : term?.midterm_end ?? '', finalStart: clone ? '' : term?.final_start ?? '', finalEnd: clone ? '' : term?.final_end ?? '',
    gradeTarget: term?.grade_target ?? 100, status: clone ? 'upcoming' : term?.status ?? 'upcoming',
  });
  const { busy, run } = useAction();
  const body = { ...f, midtermStart: f.midtermStart || null, midtermEnd: f.midtermEnd || null, finalStart: f.finalStart || null, finalEnd: f.finalEnd || null };
  const save = () => run(() => (clone ? api(`/terms/${term.id}/clone`, { body }) : term ? api(`/terms/${term.id}`, { method: 'PUT', body }) : api('/terms', { body })), clone ? 'Term cloned' : 'Term saved').then((r) => { if (r) { onDone(r.id); onClose(); } });
  return (
    <Dialog title={clone ? `Clone ${term.name} into a new term` : term ? 'Edit term' : 'New term'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name || !f.startDate || !f.endDate} onClick={save}>{clone ? 'Create new term' : 'Save'}</button></>}>
      {clone && <Notice tone="info">Classes, meeting times, Lecture/Practice rules, grading setups and class pay rates are copied, with start dates shifted by the same number of days. Students, plans, attendance, grades and teaching records are not copied.</Notice>}
      <Field label="Name"><input id="t-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Semester 2, 2026–27" /></Field>
      <div className="form-grid">
        <Field label="Start"><input id="t-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="End"><input id="t-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Midterm from"><input id="t-ms" type="date" value={f.midtermStart} onChange={(e) => setF({ ...f, midtermStart: e.target.value })} /></Field>
        <Field label="Midterm to"><input id="t-me" type="date" value={f.midtermEnd} onChange={(e) => setF({ ...f, midtermEnd: e.target.value })} /></Field>
        <Field label="Final exams from"><input id="t-fs" type="date" value={f.finalStart} onChange={(e) => setF({ ...f, finalStart: e.target.value })} /></Field>
        <Field label="Final exams to"><input id="t-fe" type="date" value={f.finalEnd} onChange={(e) => setF({ ...f, finalEnd: e.target.value })} /></Field>
        <Field label="Grade total" hint="Component maximums must add up to this."><input id="t-target" type="number" value={f.gradeTarget} onChange={(e) => setF({ ...f, gradeTarget: +e.target.value })} /></Field>
        {!clone && term && <Field label="Status"><select id="t-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="upcoming">Upcoming</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select></Field>}
      </div>
    </Dialog>
  );
}

export function TermDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: term, error, loading, reload } = useApi<any>(`/terms/${id}`);
  const [editing, setEditing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [hol, setHol] = useState({ date: '', endDate: '', name: '' });
  const { busy, run } = useAction();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !term) return <div className="page"><Loading /></div>;
  if (!term) return null;
  return (
    <div className="page">
      <div className="page-head">
        <div><div className="eyebrow"><Link to="/terms">Terms</Link></div><h1>{term.name}</h1><p className="sub mono"><D date={term.start_date} year /> – <D date={term.end_date} year /></p></div>
        <div className="toolbar">
          <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" />Edit</button>
          <button className="btn" onClick={() => setCloning(true)}>Clone into new term</button>
          {term.status !== 'archived' && <button className="btn" onClick={() => setArchiving(true)}>Archive</button>}
          {!term.classes.length && <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/terms/${term.id}`, { method: 'DELETE' }), 'Term deleted').then((r) => { if (r) nav('/terms'); })}>Delete</button>}
        </div>
      </div>
      <div className="grid two">
        <section className="panel">
          <div className="panel-head"><h2>Classes</h2></div>
          {term.classes.length ? <ul className="ledger">{term.classes.map((c: any) => <li key={c.id}><span className="dot" style={{ background: c.color, marginTop: 7 }} /><div className="grow"><Link to={`/classes/${c.id}`} className="mono">{c.code}</Link> <span className="small">{c.course_name}</span></div><span className="mono small faint">starts <D date={c.start_date} /></span></li>)}</ul> : <Empty title="No classes in this term" />}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Term-only non-teaching days</h2></div>
          <div className="panel-body stack">
            <p className="faint xs">National holidays apply to every term and are edited in Settings. Add school events or breaks that only affect this term here.</p>
            {term.holidays.length ? <ul className="ledger panel">{term.holidays.map((h: any) => <li key={h.id}><span className="when"><D date={h.date} />{h.end_date && <> – <D date={h.end_date} /></>}</span><span className="grow small">{h.name}</span><button className="btn sm ghost" aria-label="Remove" onClick={() => run(() => api(`/holidays/${h.id}`, { method: 'DELETE' })).then(reload)}><Icon name="trash" /></button></li>)}</ul> : null}
            <div className="form-grid">
              <Field label="From"><input id="h-from" type="date" value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} /></Field>
              <Field label="To (optional)"><input id="h-to" type="date" value={hol.endDate} onChange={(e) => setHol({ ...hol, endDate: e.target.value })} /></Field>
              <Field label="Name"><input id="h-name" value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} placeholder="Sports day" /></Field>
            </div>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !hol.date || !hol.name} onClick={() => run(() => api('/holidays', { body: { ...hol, endDate: hol.endDate || null, termId: term.id } }), 'Added. Use “Check holidays” in Settings or a class plan to see the impact.').then(() => { setHol({ date: '', endDate: '', name: '' }); reload(); })}>Add</button>
          </div>
        </section>
      </div>
      {editing && <TermForm term={term} onClose={() => setEditing(false)} onDone={reload} />}
      {cloning && <TermForm term={term} clone onClose={() => setCloning(false)} onDone={(nid) => nid && nav(`/terms/${nid}`)} />}
      {archiving && <Confirm title="Archive this term?" body="Its classes are archived too. Nothing is deleted; archived classes stay readable and exportable." confirmLabel="Archive" onConfirm={() => run(() => api(`/terms/${term.id}`, { method: 'PUT', body: { status: 'archived' } }), 'Term archived').then(reload)} onClose={() => setArchiving(false)} />}
    </div>
  );
}

/** Re-checks every active class against the holiday calendar; shows each class's proposal. */
export function HolidayCheck() {
  const [results, setResults] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api('/holidays/check', { body: {} })).then((r) => r && setResults(r))}>Check classes against holidays</button>
      {results && (results.length ? (
        <ul className="ledger panel">{results.map((r) => <li key={r.classId}><span className="mono grow">{r.code}</span><span className="small">{r.proposal.changes.length} change(s)</span><button className="btn sm primary" onClick={() => setOpen(r.proposal)}>Review</button></li>)}</ul>
      ) : <Notice tone="ok">Every class already matches the holiday calendar.</Notice>)}
      {open && <ProposalReview proposal={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); setResults((rs) => rs?.filter((x) => x.proposal.id !== open.id) ?? null); }} />}
    </div>
  );
}
