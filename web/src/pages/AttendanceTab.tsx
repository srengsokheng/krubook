import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { download, isOfflineCopy, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Empty, ErrorNote, Icon, Kind, Loading, Notice, fmt, useToast } from '../ui.tsx';
import { enqueue, onApplied, pendingOps } from '../offline.ts';
import { formatDate } from '../../../shared/dates.ts';

const MARKS = [['present', 'P'], ['late', 'L'], ['absent', 'A'], ['excused', 'E']] as const;

export function AttendanceTab({ cls }: { cls: any }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'roll' | 'summary'>('roll');
  const { data: sessions } = useApi<any[]>(`/classes/${cls.id}/sessions`);
  const held = useMemo(() => (sessions ?? []).filter((s) => s.date <= cls.today && (s.status === 'planned' || s.status === 'completed')), [sessions, cls.today]);
  const chosen = Number(params.get('session')) || held.at(-1)?.id || null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between no-print">
        <div className="row">
          <div className="seg"><button className={view === 'roll' ? 'on' : ''} onClick={() => setView('roll')}>Roll call</button><button className={view === 'summary' ? 'on' : ''} onClick={() => setView('summary')}>Summary</button></div>
          {view === 'roll' && (
            <select aria-label="Session" value={chosen ?? ''} onChange={(e) => setParams({ session: e.target.value })} style={{ width: 300 }}>
              {[...held].reverse().map((s) => <option key={s.id} value={s.id}>{formatDate(s.date, lang)} {s.start_time} · {s.kind}{s.attendance_marks ? ` · ${s.attendance_marks} marked` : ''}</option>)}
            </select>
          )}
        </div>
        <div className="row">
          <button className="btn" onClick={() => download(`/export/attendance/${cls.id}`).catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Excel</button>
          <Link className="btn" to={`/print/attendance/${cls.id}`} target="_blank"><Icon name="printer" />PDF</Link>
        </div>
      </div>
      {view === 'roll' ? (chosen ? <Roll sessionId={chosen} cls={cls} /> : <div className="panel"><Empty title="No sessions have taken place yet">Attendance opens on the day of each session. Cancelled sessions never count as absences.</Empty></div>) : <Summary cls={cls} />}
      {view === 'roll' && <p className="faint xs">{t('Attendance')} is saved on this device first, so it works without a connection. Sessions without a roll call are not counted as absences.</p>}
    </div>
  );
}

function Roll({ sessionId, cls }: { sessionId: number; cls: any }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/sessions/${sessionId}/attendance`);
  const [marks, setMarks] = useState<Record<number, { status: string | null; version: number | null; pending?: boolean }>>({});
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!data) return;
    const m: typeof marks = {};
    for (const r of data.roster) m[r.enrollmentId] = { status: r.status, version: r.version };
    pendingOps().then((ops) => {
      for (const op of ops) if (op.type === 'attendance' && op.sessionId === sessionId && m[op.enrollmentId]) m[op.enrollmentId] = { ...m[op.enrollmentId], status: op.status, pending: true };
      setMarks({ ...m });
    });
  }, [data, sessionId]);
  // After a sync, re-read the roll so the copy kept for offline use matches the server.
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => onApplied((list) => {
    setMarks((prev) => {
      const n = { ...prev };
      for (const a of list) if (a.op.type === 'attendance' && a.op.sessionId === sessionId && n[a.op.enrollmentId]) n[a.op.enrollmentId] = { ...n[a.op.enrollmentId], version: a.version, pending: false };
      return n;
    });
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(reload, 1500);
  }), [sessionId, reload]);

  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  if (!data) return null;
  const roster = data.roster.filter((r: any) => !q || r.code.includes(q) || (r.nameLatin ?? '').toLowerCase().includes(q.toLowerCase()) || (r.nameKm ?? '').includes(q));
  const set = (ids: number[], status: string | null) => {
    const ops = ids.filter((id) => marks[id]?.status !== status).map((id) => {
      const r = data.roster.find((x: any) => x.enrollmentId === id);
      return { type: 'attendance' as const, sessionId, enrollmentId: id, status, baseVersion: marks[id]?.version ?? null, label: `${cls.code} ${formatDate(data.session.date)} ${r.code}` };
    });
    if (!ops.length) return;
    setMarks((m) => { const n = { ...m }; for (const o of ops) n[o.enrollmentId] = { ...n[o.enrollmentId], status, pending: true }; return n; });
    void enqueue(ops);
  };
  const counts = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 } as Record<string, number>;
  for (const r of data.roster) counts[marks[r.enrollmentId]?.status ?? 'unmarked']++;
  const unmarked = data.roster.filter((r: any) => !marks[r.enrollmentId]?.status && r.enrollmentStatus === 'active').map((r: any) => r.enrollmentId);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="row"><span>{formatDate(data.session.date, lang, true)}</span><span className="mono small muted">{data.session.start}–{data.session.end}</span><Kind kind={data.session.kind} /></h2>
          <div className="row small muted" style={{ gap: 12, marginTop: 4 }}>
            {MARKS.map(([k, s]) => <span key={k}><b className="mono">{counts[k]}</b> {t(k)}</span>)}<span><b className="mono">{counts.unmarked}</b> not marked</span>
          </div>
        </div>
        <div className="row">
          <div className="search" style={{ minWidth: 160 }}><Icon name="search" /><input aria-label="Find student" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find" /></div>
          <button className="btn primary" disabled={!data.editable || !unmarked.length} onClick={() => { set(unmarked, 'present'); toast(`${unmarked.length} marked present. Tap anyone who was late or absent.`); }}><Icon name="check" />{t('Mark everyone present')}</button>
        </div>
      </div>
      {isOfflineCopy(data) && <div className="panel-body"><Notice tone="warn">Offline: showing the roll as last loaded. Marks are saved on this device and sync later.</Notice></div>}
      {!data.editable && <div className="panel-body"><Notice tone="info">{data.reason}</Notice></div>}
      <div className="roll">
        {roster.map((r: any) => {
          const m = marks[r.enrollmentId];
          return (
            <div key={r.enrollmentId} className="roll-row">
              <div className="who">
                <div>{r.nameKm ?? r.nameLatin}{m?.pending && <span className="faint xs"> · saving</span>}</div>
                <div className="faint xs mono">{r.code} {r.nameKm && <span style={{ fontFamily: 'var(--font-body)' }}>{r.nameLatin}</span>}{r.enrollmentStatus !== 'active' && ` · ${r.enrollmentStatus}`}</div>
              </div>
              <div className="marks" role="radiogroup" aria-label={`Attendance for ${r.code}`}>
                {MARKS.map(([k, s]) => (
                  <button key={k} role="radio" aria-checked={m?.status === k} title={t(k)} className={`${k} ${m?.status === k ? 'on' : ''}`} disabled={!data.editable} onClick={() => set([r.enrollmentId], m?.status === k ? null : k)}>{s}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Summary({ cls }: { cls: any }) {
  const { data, error, loading, reload } = useApi<any>(`/classes/${cls.id}/attendance`);
  const { lang } = useI18n();
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  if (!data) return null;
  const held = data.sessions.filter((s: any) => s.marked > 0);
  const cell = new Map(data.cells.map((c: any) => [`${c.session_id}:${c.enrollment_id}`, c.status]));
  const short: Record<string, string> = { present: 'P', late: 'L', absent: 'A', excused: 'E' };
  const color: Record<string, string> = { present: 'var(--ok)', late: 'var(--warn)', absent: 'var(--bad)', excused: 'var(--ink-3)' };
  return (
    <div className="stack">
      <p className="muted small">Score out of {data.max ?? '—'}: late counts as {data.rule.lateCredit} of a present mark; excused absences are {data.rule.excused === 'exclude' ? 'not counted' : `counted as ${data.rule.excused}`}. Only sessions with a roll call count. Change this in the gradebook’s grading setup.</p>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead><tr><th className="sticky-1">ID</th><th className="sticky-2">Name</th>{held.map((s: any) => <th key={s.id} title={s.date}>{formatDate(s.date, lang).split(' ').slice(1).join(' ')}</th>)}<th>%</th><th>Score</th></tr></thead>
          <tbody>
            {data.students.map((s: any) => (
              <tr key={s.enrollmentId} className={s.enrollmentStatus !== 'active' ? 'dim' : ''}>
                <td className="id sticky-1">{s.code}</td>
                <td className="name sticky-2">{s.nameKm ?? s.nameLatin}</td>
                {held.map((h: any) => { const v = cell.get(`${h.id}:${s.enrollmentId}`) as string | undefined; return <td key={h.id} className="mono" style={{ textAlign: 'center', color: v ? color[v] : undefined, fontWeight: 600 }}>{v ? short[v] : ''}</td>; })}
                <td className="total">{s.percent == null ? '—' : fmt(s.percent, 0)}</td>
                <td className="total">{fmt(s.score, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
