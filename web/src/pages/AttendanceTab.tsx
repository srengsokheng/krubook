import { useEffect, useMemo, useRef, useState } from 'react';
import { usePref } from '../prefs.ts';
import { Link, useSearchParams } from 'react-router-dom';
import { download, isOfflineCopy, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Confirm, Empty, ErrorNote, Icon, Kind, Loading, Notice, Pager, fmt, useDebounced, useToast } from '../ui.tsx';
import { enqueue, onApplied, pendingOps } from '../offline.ts';
import { formatDate } from '../../../shared/dates.ts';

export function AttendanceTab({ cls }: { cls: any }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [view, setView] = usePref<'roll' | 'summary'>('view.attendance', 'roll');
  const { data: sessions } = useApi<any[]>(`/classes/${cls.id}/sessions`);
  const held = useMemo(() => (sessions ?? []).filter((s) => s.date <= cls.today && (s.status === 'planned' || s.status === 'completed')), [sessions, cls.today]);
  const chosen = Number(params.get('session')) || held.at(-1)?.id || null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between no-print">
        <div className="row">
          <div className="seg"><button className={view === 'roll' ? 'on' : ''} onClick={() => setView('roll')}>Roll call</button><button className={view === 'summary' ? 'on' : ''} onClick={() => setView('summary')}>Summary</button></div>
          {view === 'roll' && (
            <select aria-label="Session" value={chosen ?? ''} onChange={(e) => setParams({ session: e.target.value })} style={{ width: 'auto', maxWidth: '100%' }}>
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
      {view === 'roll' && <p className="faint xs">{t('Attendance')} is saved on this device first, so it works without a connection. Ticked students came; once a roll call is started, everyone left unticked counts as absent. Sessions without a roll call are not counted.</p>}
    </div>
  );
}

// A roll call is one tick per student: ticked came, unticked did not. Once a roll call is started
// (any student marked), every student left unticked is saved as absent, so the record matches what
// is on screen. Late and excused marks from earlier records are still shown and counted.
const CAME = new Set(['present', 'late']);

function Roll({ sessionId, cls }: { sessionId: number; cls: any }) {
  const { lang } = useI18n();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/sessions/${sessionId}/attendance`);
  // null until the saved marks and this device's unsent ones are merged: a tap before that would be
  // read as the first tick of a fresh roll call and mark everyone else absent.
  const [marks, setMarks] = useState<Record<number, { status: string | null; version: number | null; pending?: boolean }> | null>(null);
  const [q, setQ] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => { setMarks(null); }, [sessionId]);
  useEffect(() => {
    if (!data || data.session.id !== sessionId) return;
    let live = true;
    const m: Record<number, { status: string | null; version: number | null; pending?: boolean }> = {};
    for (const r of data.roster) m[r.enrollmentId] = { status: r.status, version: r.version };
    pendingOps().then((ops) => {
      for (const op of ops) if (op.type === 'attendance' && op.sessionId === sessionId && m[op.enrollmentId]) m[op.enrollmentId] = { ...m[op.enrollmentId], status: op.status, pending: true };
      if (live) setMarks({ ...m });
    });
    return () => { live = false; };
  }, [data, sessionId]);
  // After a sync, re-read the roll so the copy kept for offline use matches the server.
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => onApplied((list) => {
    setMarks((prev) => {
      if (!prev) return prev;
      const n = { ...prev };
      for (const a of list) if (a.op.type === 'attendance' && a.op.sessionId === sessionId && n[a.op.enrollmentId]) n[a.op.enrollmentId] = { ...n[a.op.enrollmentId], version: a.version, pending: false };
      return n;
    });
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(reload, 1500);
  }), [sessionId, reload]);

  if (error) return <ErrorNote error={error} retry={reload} />;
  if ((loading && !data) || (data && !marks) || (data && data.session.id !== sessionId)) return <Loading rows={8} />;
  if (!data || !marks) return null;
  const roster = data.roster.filter((r: any) => !q || r.code.includes(q) || (r.nameLatin ?? '').toLowerCase().includes(q.toLowerCase()) || (r.nameKm ?? '').includes(q));
  const active = data.roster.filter((r: any) => r.enrollmentStatus === 'active');
  const unmarked = active.filter((r: any) => !marks[r.enrollmentId]?.status).map((r: any) => r.enrollmentId as number);
  const set = (changes: Array<[number, string | null]>) => {
    const ops = changes.filter(([id, status]) => marks[id]?.status !== status).map(([id, status]) => {
      const r = data.roster.find((x: any) => x.enrollmentId === id);
      return { type: 'attendance' as const, sessionId, enrollmentId: id, status, baseVersion: marks[id]?.version ?? null, label: `${cls.code} ${formatDate(data.session.date)} ${r.code}` };
    });
    if (!ops.length) return;
    setMarks((m) => { const n = { ...m! }; for (const o of ops) n[o.enrollmentId] = { ...n[o.enrollmentId], status: o.status, pending: true }; return n; });
    void enqueue(ops);
  };
  const toggle = (id: number) => {
    const next = CAME.has(marks[id]?.status ?? '') ? 'absent' : 'present';
    set([[id, next], ...unmarked.filter((x: number) => x !== id).map((x: number): [number, string] => [x, 'absent'])]);
  };
  const counts = { came: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const r of data.roster) {
    const s = marks[r.enrollmentId]?.status;
    if (!s) { if (r.enrollmentStatus === 'active') counts.unmarked++; } else if (CAME.has(s)) counts.came++; else if (s === 'excused') counts.excused++; else counts.absent++;
  }
  const started = counts.came + counts.absent + counts.excused > 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="row"><span>{formatDate(data.session.date, lang, true)}</span><span className="mono small muted">{data.session.start}–{data.session.end}</span><Kind kind={data.session.kind} /></h2>
          <div className="row small muted" style={{ gap: 12, marginTop: 4 }}>
            {started ? <>
              <span><b className="mono">{counts.came}</b> came</span>
              <span><b className="mono">{counts.absent}</b> absent</span>
              {counts.excused > 0 && <span><b className="mono">{counts.excused}</b> excused</span>}
              {counts.unmarked > 0 && <span><b className="mono">{counts.unmarked}</b> not marked</span>}
            </> : <span>Roll call not taken yet. Tick the students who came.</span>}
          </div>
        </div>
        <div className="row">
          <div className="search" style={{ minWidth: 160 }}><Icon name="search" /><input aria-label="Find student" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find" /></div>
          {started && <button className="btn ghost" disabled={!data.editable} onClick={() => setClearing(true)}>Clear</button>}
          <button className="btn primary" disabled={!data.editable || !unmarked.length} onClick={() => { set(unmarked.map((id: number): [number, string] => [id, 'present'])); toast(`${unmarked.length} ticked. Untick anyone who did not come.`); }}><Icon name="check" />{started ? 'Tick the rest' : 'Everyone came'}</button>
        </div>
      </div>
      {isOfflineCopy(data) && <div className="panel-body"><Notice tone="warn">Offline: showing the roll as last loaded. Ticks are saved on this device and sync later.</Notice></div>}
      {!data.editable && <div className="panel-body"><Notice tone="info">{data.reason}</Notice></div>}
      <div className="roll">
        {roster.map((r: any) => {
          const m = marks[r.enrollmentId];
          const came = CAME.has(m?.status ?? '');
          const state = !m?.status ? 'unmarked' : came ? 'came' : 'away';
          return (
            <button key={r.enrollmentId} type="button" role="checkbox" aria-checked={came} aria-label={`${r.code} ${r.nameLatin ?? r.nameKm ?? ''}`} className={`roll-row tick ${state}`} disabled={!data.editable} onClick={() => toggle(r.enrollmentId)}>
              <span className="box" aria-hidden="true">{came ? <Icon name="check" /> : state === 'away' ? <Icon name="x" /> : null}</span>
              <span className="who">
                <span>{r.nameKm ?? r.nameLatin}{m?.pending && <span className="faint xs"> · saving</span>}</span>
                <span className="faint xs mono">{r.code} {r.nameKm && <span style={{ fontFamily: 'var(--font-body)' }}>{r.nameLatin}</span>}{r.enrollmentStatus !== 'active' && ` · ${r.enrollmentStatus}`}</span>
              </span>
              {(m?.status === 'late' || m?.status === 'excused') && <span className="pill">{m.status}</span>}
            </button>
          );
        })}
      </div>
      {clearing && <Confirm title="Clear this roll call?" body="Every tick and absence for this session is removed. The session then counts as having no roll call." confirmLabel="Clear roll call" danger onConfirm={() => { set(data.roster.filter((r: any) => marks[r.enrollmentId]?.status).map((r: any): [number, null] => [r.enrollmentId, null])); toast('Roll call cleared'); }} onClose={() => setClearing(false)} />}
    </section>
  );
}

function Summary({ cls }: { cls: any }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = usePref<number>('pageSize.attendance', 10);
  const [text, setText] = useState('');
  const q = useDebounced(text);
  useEffect(() => setPage(1), [q]);
  const { data, error, loading, reload } = useApi<any>(`/classes/${cls.id}/attendance?page=${page}&pageSize=${size}&q=${encodeURIComponent(q)}`);
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
      <div className="row between">
        <div className="search" style={{ minWidth: 200 }}><Icon name="search" /><input aria-label="Find student" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find student" /></div>
        <span className="faint xs" title="Change this in the gradebook's grading setup.">Score /{data.max ?? '—'} · late = {data.rule.lateCredit} · excused {data.rule.excused === 'exclude' ? 'not counted' : `as ${data.rule.excused}`}</span>
      </div>
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
      <Pager meta={data} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} noun="students" />
    </div>
  );
}
