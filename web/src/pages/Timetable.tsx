import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Dialog, Empty, ErrorNote, Field, Icon, Kind, Loading, Notice, useAction } from '../ui.tsx';
import { SessionDialog } from '../SessionDialog.tsx';
import { ProposalReview, type Proposal } from '../Proposal.tsx';
import { addDays, formatDate, minutesOf, weekday, weekdayName } from '../../../shared/dates.ts';

function useNarrow() {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 720px)');
    const on = () => setN(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return n;
}

export function Timetable() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const from = params.get('week') ?? '';
  const { data, error, loading, reload } = useApi<any>(`/timetable${from ? `?from=${from}` : ''}`);
  const { data: holidays } = useApi<any[]>('/holidays');
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const narrow = useNarrow();

  const days = useMemo(() => {
    if (!data) return [];
    const all = Array.from({ length: 7 }, (_, i) => addDays(data.from, i));
    // Sunday only appears when something is scheduled on it.
    return all.filter((d) => weekday(d) !== 0 || data.sessions.some((s: any) => s.date === d) || data.ghosts.some((g: any) => g.date === d));
  }, [data]);
  const clash = useMemo(() => new Set<number>((data?.overlaps ?? []).flat()), [data]);
  const holidayOn = (d: string) => holidays?.filter((h) => h.date === d).map((h) => (lang === 'km' && h.name_km) || h.name)[0];

  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="page"><Loading rows={6} /></div>;
  if (!data) return null;

  const items = [...data.sessions, ...data.ghosts];
  const startMin = Math.min(7 * 60, ...items.map((s: any) => minutesOf(s.start)));
  const endMin = Math.max(17 * 60, ...items.map((s: any) => minutesOf(s.end)));
  const first = Math.floor(startMin / 60) * 60;
  const hours = Math.ceil((endMin - first) / 60);
  const HOUR = 56;
  const pos = (s: any) => ({ top: ((minutesOf(s.start) - first) / 60) * HOUR + 1, height: Math.max(22, ((minutesOf(s.end) - minutesOf(s.start)) / 60) * HOUR - 3) });
  const open = data.sessions.find((s: any) => s.id === openId);
  const go = (d: string) => setParams({ week: d });

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('Week')} of {formatDate(data.from, lang, true)}</div>
          <h1>{t('Timetable')}</h1>
        </div>
        <div className="toolbar no-print">
          <button className="btn" onClick={() => go(addDays(data.from, -7))} aria-label="Previous week"><Icon name="left" /></button>
          <button className="btn" onClick={() => setParams({})}>{t('This week')}</button>
          <button className="btn" onClick={() => go(addDays(data.from, 7))} aria-label="Next week"><Icon name="right" /></button>
          <input type="date" aria-label="Jump to week" value={data.from} onChange={(e) => e.target.value && go(e.target.value)} style={{ width: 150 }} />
          <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" />Add session</button>
          <button className="btn" onClick={() => window.print()}><Icon name="printer" />{t('Print')}</button>
        </div>
      </div>

      {data.overlaps.length > 0 && <Notice tone="bad">Double-booked this week: {data.overlaps.map(([a, b]: number[]) => { const x = data.sessions.find((s: any) => s.id === a), y = data.sessions.find((s: any) => s.id === b); return `${x.code} and ${y.code} on ${formatDate(x.date, lang)} ${x.start}`; }).join('; ')}.</Notice>}

      <div className="row small muted no-print" style={{ gap: 14 }}>
        <span className="row" style={{ gap: 6 }}><Kind kind="lecture" /> <Kind kind="practice" /> <Kind kind="exam" /></span>
        <span>Dashed outline: class not started yet</span>
        <span>Struck through: cancelled</span>
        <span>Red outline: double-booked</span>
      </div>

      {!data.sessions.length && !data.ghosts.length ? (
        <div className="panel"><Empty title="No sessions this week">Generate a term plan from a class page, or add a session.</Empty></div>
      ) : narrow ? (
        <div className="stack">
          {days.map((d) => {
            const list = items.filter((s: any) => s.date === d).sort((a: any, b: any) => a.start.localeCompare(b.start));
            return (
              <section key={d} className="panel">
                <div className={`panel-head ${d === data.today ? 'marker' : ''}`}><h3>{formatDate(d, lang)}</h3>{holidayOn(d) && <span className="pill">{holidayOn(d)}</span>}</div>
                {list.length ? <ul className="ledger">{list.map((s: any, i: number) => (
                  <li key={s.id ?? `g${i}`} onClick={() => s.id && setOpenId(s.id)} style={{ cursor: s.id ? 'pointer' : 'default' }}>
                    <span className="swatch" style={{ background: s.color }} />
                    <span className="when">{s.start}–{s.end}</span>
                    <div className="grow">
                      <div className="row"><b className={`mono ${s.status === 'cancelled' ? 'strike' : ''}`}>{s.code}</b>{s.kind && <Kind kind={s.kind} />}{clash.has(s.id) && <span className="pill bad">clash</span>}</div>
                      <div className="small muted">{s.startsOn ? `Starts ${formatDate(s.startsOn, lang)}` : s.status === 'cancelled' ? s.note : s.part ?? s.checkpoint ?? s.course_name}</div>
                    </div>
                  </li>
                ))}</ul> : <div className="panel-body faint small">No classes</div>}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="panel table-wrap">
          <div className="tt" style={{ ['--days' as any]: days.length, ['--hour' as any]: `${HOUR}px` }}>
            <div className="tt-head" />
            {days.map((d) => (
              <div key={d} className={`tt-head ${d === data.today ? 'today' : ''}`}>
                <div className="eyebrow" style={{ color: 'inherit' }}>{weekdayName(weekday(d), lang)}</div>
                <div className="d">{+d.slice(8)}</div>
              </div>
            ))}
            <div className="tt-times" style={{ height: hours * HOUR }}>
              {Array.from({ length: hours + 1 }, (_, i) => <span key={i} style={{ top: i * HOUR }}>{String(first / 60 + i).padStart(2, '0')}:00</span>)}
            </div>
            {days.map((d) => (
              <div key={d} className={`tt-col ${d === data.today ? 'today' : ''} ${holidayOn(d) ? 'holiday' : ''}`} style={{ height: hours * HOUR }}>
                {holidayOn(d) && <div className="tt-holiday">{holidayOn(d)}</div>}
                {data.ghosts.filter((g: any) => g.date === d).map((g: any, i: number) => (
                  <div key={`g${i}`} className="tt-ev ghost" style={{ ...pos(g), ['--c' as any]: g.color }} title={`${g.code} starts ${g.startsOn}`}>
                    <div className="code">{g.code}</div>
                    <div className="t">{g.start}–{g.end}</div>
                    <div>Starts {formatDate(g.startsOn, lang)}</div>
                  </div>
                ))}
                {data.sessions.filter((s: any) => s.date === d).map((s: any) => (
                  <button key={s.id} className={`tt-ev ${s.status} ${clash.has(s.id) ? 'clash' : ''} ${s.moved_from_id ? 'moved-here' : ''}`} style={{ ...pos(s), ['--c' as any]: s.color }} onClick={() => setOpenId(s.id)}
                    title={`${s.code} ${s.course_name} ${s.start}–${s.end}`}>
                    <div className="row" style={{ gap: 5, justifyContent: 'space-between' }}><span className="code">{s.code}</span><Kind kind={s.kind} /></div>
                    <div className="t">{s.start}–{s.end}{s.status === 'completed' && ' ✓'}</div>
                    <div>{s.status === 'cancelled' ? s.note ?? 'Cancelled' : s.checkpoint ? <span className="marker">{s.checkpoint}</span> : s.part ?? s.activity.replace('_', ' ')}</div>
                    {s.is_makeup ? <div className="faint">Make-up</div> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {open && <SessionDialog session={open} today={data.today} onClose={() => setOpenId(null)} onChanged={reload} />}
      {adding && <AddSession defaultDate={data.today >= data.from && data.today <= data.to ? data.today : data.from} onClose={() => setAdding(false)} onDone={reload} />}
    </div>
  );
}

export function AddSession({ defaultDate, classId, onClose, onDone }: { defaultDate: string; classId?: number; onClose: () => void; onDone: () => void }) {
  const { data: classes } = useApi<any[]>(classId ? null : '/classes');
  const [f, setF] = useState({ classId: classId ?? 0, date: defaultDate, start: '08:00', end: '09:30', kind: 'lecture', makeup: true, note: '' });
  const [result, setResult] = useState<{ overlaps: any[]; proposal: Proposal | null } | null>(null);
  const { busy, run } = useAction();
  if (result?.proposal) return <ProposalReview proposal={result.proposal} onClose={onClose} onDone={() => { onDone(); onClose(); }} />;
  return (
    <Dialog title="Add a session" onClose={onClose} footer={
      result ? <button className="btn primary" onClick={onClose}>Done</button> : <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.classId} onClick={() => run(() => api(`/classes/${f.classId}/sessions`, { body: f }), 'Session added').then((r) => { if (r) { onDone(); if (r.overlaps.length || r.proposal) setResult(r); else onClose(); } })}>Add session</button>
      </>}>
      {result?.overlaps.length ? <Notice tone="warn">Added, but it overlaps {result.overlaps.map((o) => `${o.code} ${o.start}–${o.end}`).join(', ')}. Move one of them if you cannot teach both.</Notice> : null}
      {!classId && (
        <Field label="Class">
          <select id="add-class" value={f.classId} onChange={(e) => setF({ ...f, classId: +e.target.value })}>
            <option value={0}>Choose a class…</option>
            {classes?.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.code} — {c.course_name}</option>)}
          </select>
        </Field>
      )}
      <div className="form-grid">
        <Field label="Date"><input id="add-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Start"><input id="add-start" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="End"><input id="add-end" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
        <Field label="Type">
          <select id="add-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="lecture">Lecture</option><option value="practice">Practice</option><option value="exam">Exam</option></select>
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.makeup} onChange={(e) => setF({ ...f, makeup: e.target.checked })} /> Make-up class (replaces a missed session)</label>
      <Field label="Note"><input id="add-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Dialog>
  );
}
