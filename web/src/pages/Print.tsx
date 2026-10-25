import { Route, Routes, useParams } from 'react-router-dom';
import { useApi } from '../api.ts';
import { ErrorNote, Icon, Loading, fmt } from '../ui.tsx';
import { formatDate } from '../../../shared/dates.ts';

// Print layouts for "Save as PDF". The browser shapes Khmer text with the bundled Kantumruy Pro
// font, so Khmer names print correctly; table headers repeat on every page.

export function PrintView() {
  return (
    <Routes>
      <Route path="gradebook/:id" element={<PrintGradebook />} />
      <Route path="plan/:id" element={<PrintPlan />} />
      <Route path="attendance/:id" element={<PrintAttendance />} />
      <Route path="roster/:id" element={<PrintRoster />} />
    </Routes>
  );
}

function Sheet({ title, cls, children }: { title: string; cls: any; children: React.ReactNode }) {
  return (
    <div className="print-sheet">
      <div className="row between" style={{ marginBottom: 14, gap: 12 }}>
        <div>
          <div className="eyebrow">KruBook · {title}</div>
          <h1 className="mono" style={{ fontSize: '1.3rem' }}>{cls?.code} <span style={{ fontFamily: 'var(--font-body)', fontWeight: 500 }}>{cls?.course?.name}</span></h1>
          <div className="small muted">{cls?.term?.name} · printed {new Date().toLocaleDateString('en-CA')}</div>
        </div>
        <button className="btn primary no-print" onClick={() => window.print()}><Icon name="printer" />Print or save as PDF</button>
      </div>
      <div className="print-scroll">{children}</div>
    </div>
  );
}

function useClass() {
  const { id } = useParams();
  return { id, ...useApi<any>(`/classes/${id}`) };
}

function PrintGradebook() {
  const { id, data: cls } = useClass();
  const { data: g, error } = useApi<any>(`/classes/${id}/gradebook`);
  if (error) return <ErrorNote error={error} />;
  if (!g || !cls) return <Loading />;
  return (
    <Sheet title="Gradebook" cls={cls}>
      {!g.check.valid && <p style={{ color: 'var(--bad)' }}><b>Grading setup invalid:</b> {g.check.errors.join(' ')}</p>}
      <table className="table">
        <thead><tr><th>#</th><th>ID</th><th>Khmer name</th><th>Latin name</th>{g.config.components.map((c: any) => <th key={c.id} className="num">{c.name}<br />/{c.max}</th>)}<th className="num">Total</th><th>Result</th></tr></thead>
        <tbody>{g.rows.map((r: any, i: number) => (
          <tr key={r.enrollmentId} className={r.enrollmentStatus !== 'active' && r.enrollmentStatus !== 'completed' ? 'is-dim' : ''}>
            <td className="mono">{i + 1}</td><td className="mono">{r.code}</td><td>{r.nameKm}</td><td>{r.nameLatin}</td>
            {g.config.components.map((c: any) => <td key={c.id} className="num">{r.values[c.id] ?? ''}</td>)}
            <td className="num"><b>{fmt(r.total)}</b></td><td>{r.label}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="small" style={{ marginTop: 12 }}>Average {fmt(g.stats.average, 1)} · pass rate {g.stats.passRate == null ? '—' : `${fmt(g.stats.passRate, 0)}%`} · highest {fmt(g.stats.highest)} · lowest {fmt(g.stats.lowest)} · {g.stats.missingCells} missing scores · pass mark {g.config.passMark}/{g.config.targetTotal}</p>
    </Sheet>
  );
}

function PrintPlan() {
  const { id, data: cls } = useClass();
  const { data: sessions, error } = useApi<any[]>(`/classes/${id}/sessions`);
  if (error) return <ErrorNote error={error} />;
  if (!sessions || !cls) return <Loading />;
  const part = (pid: number | null) => cls.parts.find((p: any) => p.id === pid);
  const name = (pid: number | null) => (part(pid) ? `${part(pid).code} ${part(pid).title ?? part(pid).lessonTitle}` : '');
  return (
    <Sheet title="Term plan" cls={cls}>
      <table className="table">
        <thead><tr><th>Wk</th><th>Date</th><th>Time</th><th>Type</th><th>Planned</th><th>Checkpoint</th><th>Status</th><th>Taught</th></tr></thead>
        <tbody>{sessions.map((s) => (
          <tr key={s.id} className={s.status === 'moved' ? 'is-dim' : ''}>
            <td className="mono">{s.week}</td><td className="mono">{formatDate(s.date)}</td><td className="mono">{s.start_time}–{s.end_time}</td><td>{s.kind}</td>
            <td className={s.status === 'cancelled' ? 'strike' : ''}>{s.activity === 'lesson' ? name(s.part_id) : s.activity.replace('_', ' ')}{s.status === 'cancelled' && s.note ? ` (${s.note})` : ''}</td>
            <td>{s.checkpoint}</td><td>{s.status}</td>
            <td>{s.taught_parts.map((t: any) => `${part(t.partId)?.code ?? ''}${t.coverage === 'partial' ? ' (partial)' : ''}`).join(', ')}</td>
          </tr>
        ))}</tbody>
      </table>
    </Sheet>
  );
}

function PrintAttendance() {
  const { id, data: cls } = useClass();
  const { data: a, error } = useApi<any>(`/classes/${id}/attendance`);
  if (error) return <ErrorNote error={error} />;
  if (!a || !cls) return <Loading />;
  const held = a.sessions.filter((s: any) => s.marked > 0);
  const cell = new Map(a.cells.map((c: any) => [`${c.session_id}:${c.enrollment_id}`, c.status]));
  const short: Record<string, string> = { present: 'P', late: 'L', absent: 'A', excused: 'E' };
  return (
    <Sheet title="Attendance" cls={cls}>
      <p className="small">P present · L late · A absent · E excused · blank: no roll call</p>
      <table className="table">
        <thead><tr><th>ID</th><th>Name</th>{held.map((s: any) => <th key={s.id}>{s.date.slice(5)}</th>)}<th className="num">%</th><th className="num">Score</th></tr></thead>
        <tbody>{a.students.map((s: any) => (
          <tr key={s.enrollmentId}><td className="mono">{s.code}</td><td>{s.nameKm ?? s.nameLatin}</td>{held.map((h: any) => <td key={h.id} className="mono">{short[cell.get(`${h.id}:${s.enrollmentId}`) as string] ?? ''}</td>)}<td className="num">{fmt(s.percent, 0)}</td><td className="num">{fmt(s.score)}</td></tr>
        ))}</tbody>
      </table>
    </Sheet>
  );
}

function PrintRoster() {
  const { id, data: cls } = useClass();
  const { data: rows, error } = useApi<any[]>(`/classes/${id}/roster`);
  if (error) return <ErrorNote error={error} />;
  if (!rows || !cls) return <Loading />;
  return (
    <Sheet title="Student list" cls={cls}>
      <table className="table">
        <thead><tr><th>#</th><th>ID</th><th>Khmer name</th><th>Latin name</th><th>Gender</th><th>Status</th><th style={{ width: '25%' }}>Signature</th></tr></thead>
        <tbody>{rows.filter((r) => r.status === 'active').map((r, i) => <tr key={r.enrollment_id}><td className="mono">{i + 1}</td><td className="mono">{r.student_code}</td><td>{r.name_km}</td><td>{r.name_latin}</td><td>{r.gender}</td><td>{r.status}</td><td /></tr>)}</tbody>
      </table>
    </Sheet>
  );
}
