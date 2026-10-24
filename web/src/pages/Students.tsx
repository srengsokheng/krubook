import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Confirm, D, Empty, ErrorNote, Field, Icon, Loading, Pager, Pill, fmt, useAction, useDebounced } from '../ui.tsx';

export function Students() {
  const { t } = useI18n();
  // Search, sort and page live in the URL so the back button and reloads keep them.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'code';
  const page = Number(params.get('page') ?? 1) || 1;
  const size = Number(params.get('size') ?? 25) || 25;
  const [text, setText] = useState(q);
  const debounced = useDebounced(text);
  const set = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, String(v));
    setParams(next, { replace: true });
  };
  useEffect(() => { if (debounced !== q) set({ q: debounced, page: 1 }); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = useApi<any>(`/students?q=${encodeURIComponent(q)}&sort=${sort}&page=${page}&pageSize=${size}`);
  const th = (key: string, label: string) => <th aria-sort={sort === key ? 'ascending' : 'none'}><button className="btn ghost sm" style={{ padding: 0, height: 'auto', font: 'inherit', color: 'inherit' }} onClick={() => set({ sort: key, page: 1 })}>{label}{sort === key ? ' ▲' : ''}</button></th>;
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Students')}</h1></div>
      <div className="search" style={{ maxWidth: 420 }}><Icon name="search" /><input aria-label="Search students" value={text} onChange={(e) => setText(e.target.value)} placeholder="ID, Khmer or Latin name, email" /></div>
      <ErrorNote error={error} retry={reload} />
      {loading && !data ? <Loading rows={8} /> : !data?.total ? <div className="panel"><Empty title={q ? 'No students match' : 'No students yet'}>{q ? 'Try part of a name or ID.' : 'Import a roster from a class page.'}</Empty></div> : (
        <div className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{th('code', t('Student ID'))}{th('km', t('Khmer name'))}{th('latin', t('Latin name'))}<th>Classes</th></tr></thead>
              <tbody>{data.items.map((s: any) => (
                <tr key={s.id}>
                  <td className="mono"><Link to={`/students/${s.id}`}>{s.student_code}</Link></td>
                  <td>{s.name_km}</td><td>{s.name_latin}</td>
                  <td className="mono small">{s.classes ?? <span className="faint">none</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Pager meta={data} onPage={(p) => set({ page: p })} onSize={(n) => set({ size: n, page: 1 })} noun="students" />
        </div>
      )}
    </div>
  );
}

export function StudentDetail() {
  const { id } = useParams();
  const { data: s, error, loading, reload } = useApi<any>(`/students/${id}`);
  const [f, setF] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { busy, run } = useAction();
  const nav = useNavigate();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !s) return <div className="page"><Loading /></div>;
  if (!s) return null;
  const form = f ?? { code: s.student_code, nameKm: s.name_km ?? '', nameLatin: s.name_latin ?? '', gender: s.gender ?? '', email: s.email ?? '', phone: s.phone ?? '', notes: s.notes ?? '' };
  return (
    <div className="page">
      <div className="page-head">
        <div><div className="eyebrow"><Link to="/students">Students</Link> · <span className="mono">{s.student_code}</span></div><h1>{s.name_km ?? s.name_latin}</h1>{s.name_km && <p className="sub">{s.name_latin}</p>}</div>
        {!s.enrollments.length && <button className="btn danger" onClick={() => setDeleting(true)}>Delete student</button>}
      </div>
      {deleting && <Confirm danger title="Delete this student?" body="They have no class history, so nothing else is affected." confirmLabel="Delete" onClose={() => setDeleting(false)} onConfirm={() => run(() => api(`/students/${s.id}`, { method: 'DELETE' }), 'Student deleted').then((r) => { if (r) nav('/students'); })} />}
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
