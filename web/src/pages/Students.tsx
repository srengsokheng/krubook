import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Empty, ErrorNote, Field, Icon, Loading, Pill, fmt, useAction } from '../ui.tsx';

export function Students() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const { data, error, loading, reload } = useApi<any[]>(`/students?q=${encodeURIComponent(debounced)}`);
  const [sortKm, setSortKm] = useState(false);
  const onQ = (v: string) => { setQ(v); clearTimeout((onQ as any).t); (onQ as any).t = setTimeout(() => setDebounced(v), 220); };
  const list = [...(data ?? [])];
  if (sortKm) { const c = new Intl.Collator('km'); list.sort((a, b) => c.compare(a.name_km ?? '', b.name_km ?? '')); }
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Students')}</h1><p className="sub">Every student across classes. Import rosters from a class’s Roster tab.</p></div>
      </div>
      <div className="row">
        <div className="search"><Icon name="search" /><input aria-label="Search students" value={q} onChange={(e) => onQ(e.target.value)} placeholder="ID, Khmer name, Latin name or email" /></div>
        <label className="check"><input type="checkbox" checked={sortKm} onChange={(e) => setSortKm(e.target.checked)} /> Sort by Khmer name</label>
      </div>
      <ErrorNote error={error} retry={reload} />
      {loading && !data ? <Loading rows={8} /> : !list.length ? <div className="panel"><Empty title={q ? 'No students match' : 'No students yet'} /></div> : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>{t('Student ID')}</th><th>{t('Khmer name')}</th><th>{t('Latin name')}</th><th>Current classes</th><th>Email</th></tr></thead>
            <tbody>{list.map((s) => (
              <tr key={s.id}>
                <td className="mono"><Link to={`/students/${s.id}`}>{s.student_code}</Link></td>
                <td>{s.name_km}</td><td>{s.name_latin}</td>
                <td className="mono small">{s.classes ?? <span className="faint">none</span>}</td>
                <td className="small">{s.email}</td>
              </tr>
            ))}</tbody>
          </table>
          {list.length === 500 && <div className="panel-body faint small">Showing the first 500. Search to narrow the list.</div>}
        </div>
      )}
    </div>
  );
}

export function StudentDetail() {
  const { id } = useParams();
  const { data: s, error, loading, reload } = useApi<any>(`/students/${id}`);
  const [f, setF] = useState<any | null>(null);
  const { busy, run } = useAction();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !s) return <div className="page"><Loading /></div>;
  if (!s) return null;
  const form = f ?? { code: s.student_code, nameKm: s.name_km ?? '', nameLatin: s.name_latin ?? '', gender: s.gender ?? '', email: s.email ?? '', phone: s.phone ?? '', notes: s.notes ?? '' };
  return (
    <div className="page">
      <div className="page-head">
        <div><div className="eyebrow"><Link to="/students">Students</Link> · <span className="mono">{s.student_code}</span></div><h1>{s.name_km ?? s.name_latin}</h1>{s.name_km && <p className="sub">{s.name_latin}</p>}</div>
      </div>
      <div className="grid side">
        <section className="panel">
          <div className="panel-head"><h2>Enrollment history</h2></div>
          {s.enrollments.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Class</th><th>Term</th><th>Status</th><th>From</th><th className="num">Attendance</th><th className="num">Total</th><th>Result</th></tr></thead>
                <tbody>{s.enrollments.map((e: any) => (
                  <tr key={e.id}>
                    <td><Link className="mono" to={`/classes/${e.class_id}/grades`}>{e.code}</Link><div className="faint xs">{e.course_name}</div></td>
                    <td className="small">{e.term_name}</td>
                    <td><Pill tone={e.status === 'active' ? 'ok' : undefined}>{e.status}</Pill></td>
                    <td className="mono small"><D date={e.enrolled_on} />{e.ended_on && <> – <D date={e.ended_on} /></>}</td>
                    <td className="num mono">{e.attendance?.percent == null ? '—' : `${fmt(e.attendance.percent, 0)}%`}</td>
                    <td className="num mono">{fmt(e.total, 2)}</td>
                    <td>{e.label ? <Pill tone={e.label && e.complete ? 'ok' : undefined}>{e.label}</Pill> : <span className="faint xs">{e.complete ? '' : 'in progress'}</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <Empty title="Not enrolled in any class" />}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Details</h2></div>
          <div className="panel-body stack">
            <Field label="Student ID"><input id="sd-code" className="mono" value={form.code} onChange={(e) => setF({ ...form, code: e.target.value })} /></Field>
            <Field label="Khmer name"><input id="sd-km" value={form.nameKm} onChange={(e) => setF({ ...form, nameKm: e.target.value })} /></Field>
            <Field label="Latin name"><input id="sd-lat" value={form.nameLatin} onChange={(e) => setF({ ...form, nameLatin: e.target.value })} /></Field>
            <div className="form-grid">
              <Field label="Gender"><select id="sd-g" value={form.gender} onChange={(e) => setF({ ...form, gender: e.target.value })}><option value="">—</option><option value="F">F</option><option value="M">M</option></select></Field>
              <Field label="Phone"><input id="sd-phone" value={form.phone} onChange={(e) => setF({ ...form, phone: e.target.value })} /></Field>
            </div>
            <Field label="Email"><input id="sd-email" type="email" value={form.email} onChange={(e) => setF({ ...form, email: e.target.value })} /></Field>
            <Field label="Notes"><textarea id="sd-notes" value={form.notes} onChange={(e) => setF({ ...form, notes: e.target.value })} /></Field>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !f} onClick={() => run(() => api(`/students/${s.id}`, { method: 'PUT', body: form }), 'Student saved').then(() => { setF(null); reload(); })}>Save</button>
          </div>
        </section>
      </div>
    </div>
  );
}
