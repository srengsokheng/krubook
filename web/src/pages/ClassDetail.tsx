import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, ErrorNote, Field, Icon, Kind, Loading, MaterialStatus, Notice, Pill, ProgressPill, useAction, useToast } from '../ui.tsx';
import { PlanTab } from './PlanTab.tsx';
import { RosterTab } from './RosterTab.tsx';
import { AttendanceTab } from './AttendanceTab.tsx';
import { GradebookTab } from './GradebookTab.tsx';
import { MeetingsEditor, meetingText } from './Classes.tsx';
import { formatDate, weekdayName } from '../../../shared/dates.ts';

export function ClassDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const { data: c, error, loading, reload } = useApi<any>(`/classes/${id}`);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !c) return <div className="page"><Loading rows={8} /></div>;
  if (!c) return null;
  const base = `/classes/${c.id}`;
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link to="/classes">{t('Classes')}</Link> · {c.term.name}</div>
          <h1 className="row" style={{ gap: 10 }}><span className="dot" style={{ background: c.course.color, width: 12, height: 12 }} /><span className="mono">{c.code}</span><span style={{ fontWeight: 500 }}>{c.course.name}</span></h1>
          <p className="sub">{c.meetings.length ? meetingText(c.meetings) : 'No meeting times yet'} · starts <D date={c.start_date} />{c.room ? ` · ${c.room}` : ''}</p>
        </div>
        <div className="toolbar"><Pill tone={c.status === 'active' ? 'ok' : c.status === 'upcoming' ? 'accent' : undefined}>{c.status}</Pill>{c.summary.counts.planned + c.summary.counts.completed > 0 && <ProgressPill status={c.summary.progress.status} reason={c.summary.progress.reason} />}</div>
      </div>
      <nav className="tabs no-print">
        <NavLink end to={base}>{t('Overview')}</NavLink>
        <NavLink to={`${base}/plan`}>{t('Term plan')}</NavLink>
        <NavLink to={`${base}/attendance`}>{t('Attendance')}</NavLink>
        <NavLink to={`${base}/grades`}>{t('Gradebook')}</NavLink>
        <NavLink to={`${base}/roster`}>{t('Roster')}</NavLink>
        <NavLink to={`${base}/setup`}>{t('Setup')}</NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview c={c} />} />
        <Route path="plan" element={<PlanTab cls={c} onChanged={reload} />} />
        <Route path="attendance" element={<AttendanceTab cls={c} />} />
        <Route path="grades" element={<GradebookTab cls={c} />} />
        <Route path="roster" element={<RosterTab cls={c} onChanged={reload} />} />
        <Route path="setup" element={<Setup c={c} onChanged={reload} />} />
      </Routes>
    </div>
  );
}

function Overview({ c }: { c: any }) {
  const { lang } = useI18n();
  const s = c.summary;
  const p = s.progress;
  const toast = useToast();
  return (
    <div className="grid side">
      <div className="stack" style={{ gap: 16 }}>
        {c.pendingProposal && <Notice tone="warn">A schedule change is waiting for review: {c.pendingProposal.reason}. <Link to={`/classes/${c.id}/plan`}>Review it</Link></Notice>}
        {s.unrecorded.length > 0 && <Notice tone="warn">{s.unrecorded.length} past session(s) have no teaching record yet, so they do not count as taught: {s.unrecorded.slice(0, 4).map((u: any) => formatDate(u.date, lang)).join(', ')}{s.unrecorded.length > 4 ? '…' : ''}. <Link to={`/classes/${c.id}/plan?session=${s.unrecorded[0].id}`}>Record the first one</Link></Notice>}
        <section className="panel">
          <div className="panel-head"><h2>Where the class is</h2><ProgressPill status={p.status} reason={p.reason} /></div>
          <div className="panel-body stack">
            <p>{p.reason}</p>
            <div className="progress-track" style={{ height: 10 }}>
              <div className="bar" style={{ width: `${(p.actual / Math.max(1, p.totalParts)) * 100}%` }} />
              <div className="plan" style={{ left: `${(p.expected / Math.max(1, p.totalParts)) * 100}%` }} />
            </div>
            <div className="row small muted" style={{ gap: 16 }}><span><b className="mono">{p.actual}</b> parts taught</span><span><b className="mono">{p.expected}</b> planned by today (blue mark)</span><span><b className="mono">{p.totalParts}</b> in the course</span></div>
            <div className="grid two">
              <div className="stack" style={{ gap: 4 }}>
                <div className="eyebrow">Last taught</div>
                {s.lastTaught ? <><div className="mono small"><D date={s.lastTaught.date} /></div>{s.lastTaught.parts.map((x: any) => <div key={x.id}>{x.code} {x.title ?? x.lessonTitle}{x.coverage === 'partial' && <span className="pill warn" style={{ marginLeft: 6 }}>partial</span>}</div>)}</> : <div className="faint">Nothing recorded yet</div>}
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <div className="eyebrow">Next lesson to teach</div>
                {s.nextPart ? <div><b>{s.nextPart.code}</b> {s.nextPart.title ?? s.nextPart.lessonTitle}</div> : <div className="faint">All lessons are covered</div>}
                {s.nextSession && <div className="small muted">Next session: <D date={s.nextSession.date} /> {s.nextSession.start} <Kind kind={s.nextSession.kind} /></div>}
              </div>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Prepare for the next lesson</h2>{s.nextPart && <Link className="small" to={`/courses/${c.course_id}`}>Edit materials</Link>}</div>
          {s.materials.length ? (
            <ul className="ledger">
              {s.materials.map((m: any) => (
                <li key={m.id}>
                  <span className="pill">{m.kind}</span>
                  <div className="grow">{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a> : m.title}</div>
                  <select aria-label={`Status of ${m.title}`} value={m.status} style={{ width: 140 }} onChange={async (e) => { await api(`/materials/${m.id}`, { method: 'PUT', body: { status: e.target.value } }); m.status = e.target.value; toast('Material updated'); }}>
                    <option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="ready">Ready</option>
                  </select>
                  <MaterialStatus status={m.status} />
                </li>
              ))}
            </ul>
          ) : <div className="panel-body faint small">{s.nextPart ? 'No materials are linked to this lesson yet.' : 'Nothing left to prepare.'}</div>}
        </section>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <section className="panel">
          <div className="panel-head"><h2>Coming up</h2></div>
          {s.milestones.length ? <ul className="ledger">{s.milestones.map((m: any) => <li key={m.sessionId}><span className="when"><D date={m.date} /></span><span className="grow">{m.label}</span></li>)}</ul> : <div className="panel-body faint small">No labs or exams scheduled ahead.</div>}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Sessions</h2></div>
          <div className="figures" style={{ border: 0 }}>
            <div className="figure"><span className="eyebrow">Taught</span><span className="value">{s.counts.completed}</span></div>
            <div className="figure"><span className="eyebrow">Planned</span><span className="value">{s.counts.planned}</span></div>
            <div className="figure"><span className="eyebrow">Cancelled</span><span className="value">{s.counts.cancelled}</span></div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Exports</h2></div>
          <div className="panel-body stack" style={{ gap: 8 }}>
            {[['Term plan (Excel)', `/export/plan/${c.id}`], ['Gradebook (Excel)', `/export/gradebook/${c.id}`], ['Attendance (Excel)', `/export/attendance/${c.id}`], ['Student list (Excel)', `/export/roster/${c.id}`]].map(([label, path]) => (
              <button key={path} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => download(path).catch((e) => toast(e.message, 'bad'))}><Icon name="download" />{label}</button>
            ))}
            <div className="faint xs">For PDF, open a print view and choose “Save as PDF”. Khmer text is shaped by the browser, so it prints correctly.</div>
            <div className="row">
              {[['plan', 'Term plan'], ['gradebook', 'Gradebook'], ['attendance', 'Attendance'], ['roster', 'Students']].map(([k, label]) => <Link key={k} className="btn sm" to={`/print/${k}/${c.id}`} target="_blank"><Icon name="printer" />{label}</Link>)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Setup({ c, onChanged }: { c: any; onChanged: () => void }) {
  const { lang } = useI18n();
  const { busy, run } = useAction();
  const [f, setF] = useState({ code: c.code, name: c.name ?? '', startDate: c.start_date, endDate: c.end_date ?? '', room: c.room ?? '', weeks: c.weeks, status: c.status, notes: c.notes ?? '', progressTolerance: c.progress_tolerance });
  const [meetings, setMeetings] = useState(c.meetings.map((m: any) => ({ id: m.id, weekday: m.weekday, start: m.start_time, end: m.end_time, room: m.room })));
  const [rule, setRule] = useState<any>(c.rule);
  const [custom, setCustom] = useState<boolean>(c.ruleIsCustom);
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => { setRule(c.rule); }, [c.rule]);
  const days = [...new Set(meetings.map((m: any) => m.weekday))] as number[];
  return (
    <div className="grid two">
      <section className="panel">
        <div className="panel-head"><h2>Class details</h2></div>
        <div className="panel-body stack">
          <div className="form-grid">
            <Field label="Class code"><input id="s-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Display name"><input id="s-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="First day"><input id="s-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="Last day (optional)"><input id="s-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            <Field label="Teaching weeks"><input id="s-weeks" type="number" min={1} max={40} value={f.weeks} onChange={(e) => setF({ ...f, weeks: +e.target.value })} /></Field>
            <Field label="Room"><input id="s-room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} /></Field>
            <Field label="Status">
              <select id="s-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="upcoming">Upcoming</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select>
            </Field>
            <Field label="On-schedule tolerance" hint="Lesson parts ahead or behind that still count as on schedule."><input id="s-tol" type="number" min={0} max={5} value={f.progressTolerance} onChange={(e) => setF({ ...f, progressTolerance: +e.target.value })} /></Field>
          </div>
          <Field label="Notes"><textarea id="s-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api(`/classes/${c.id}`, { method: 'PUT', body: { ...f, endDate: f.endDate || null } }), 'Class saved').then(onChanged)}>Save details</button>
          <p className="faint xs">Changing the first day or weeks affects new plans only. Regenerate the plan from the Term plan tab (possible until teaching is recorded).</p>
        </div>
      </section>
      <div className="stack" style={{ gap: 16 }}>
        <section className="panel">
          <div className="panel-head"><h2>Meeting times</h2></div>
          <div className="panel-body stack">
            <MeetingsEditor value={meetings} onChange={setMeetings} />
            {warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api(`/classes/${c.id}/meetings`, { method: 'PUT', body: { meetings } }), 'Meeting times saved').then((r) => { if (r) { setWarnings(r.warnings); onChanged(); } })}>Save meeting times</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Lecture / Practice rule</h2></div>
          <div className="panel-body stack">
            <label className="check"><input type="radio" checked={!custom} onChange={() => setCustom(false)} /> Use the course rule ({c.course.session_rule && JSON.parse(c.course.session_rule).mode === 'sequence' ? JSON.parse(c.course.session_rule).sequence.join(' → ') : 'by weekday'})</label>
            <label className="check"><input type="radio" checked={custom} onChange={() => setCustom(true)} /> Use a rule for this class only</label>
            {custom && (
              <div className="stack" style={{ gap: 8, paddingLeft: 24 }}>
                <div className="seg">
                  <button className={rule.mode === 'sequence' ? 'on' : ''} onClick={() => setRule({ mode: 'sequence', sequence: ['lecture', 'practice'] })}>Order in the week</button>
                  <button className={rule.mode === 'weekday' ? 'on' : ''} onClick={() => setRule({ mode: 'weekday', map: Object.fromEntries(days.map((d, i) => [String(d), i === 0 ? 'lecture' : 'practice'])) })}>By weekday</button>
                </div>
                {rule.mode === 'sequence' ? (
                  <div className="row">
                    {rule.sequence.map((k: string, i: number) => (
                      <select key={i} aria-label={`Meeting ${i + 1}`} value={k} style={{ width: 120 }} onChange={(e) => setRule({ ...rule, sequence: rule.sequence.map((x: string, j: number) => (i === j ? e.target.value : x)) })}>
                        <option value="lecture">Lecture</option><option value="practice">Practice</option>
                      </select>
                    ))}
                    <button className="btn sm" onClick={() => setRule({ ...rule, sequence: [...rule.sequence, 'practice'] })}>+</button>
                    {rule.sequence.length > 1 && <button className="btn sm" onClick={() => setRule({ ...rule, sequence: rule.sequence.slice(0, -1) })}>−</button>}
                    <span className="faint xs">1st, 2nd, 3rd… eligible meeting of each week. Holidays are skipped when counting.</span>
                  </div>
                ) : (
                  <div className="row">
                    {days.map((d) => (
                      <Field key={d} label={weekdayName(d, lang)}>
                        <select value={rule.map[String(d)] ?? 'lecture'} onChange={(e) => setRule({ ...rule, map: { ...rule.map, [String(d)]: e.target.value } })}><option value="lecture">Lecture</option><option value="practice">Practice</option></select>
                      </Field>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api(`/classes/${c.id}`, { method: 'PUT', body: { sessionRule: custom ? rule : null } }), 'Rule saved. Use “Review schedule changes” on the plan to apply it to future sessions.').then(onChanged)}>Save rule</button>
          </div>
        </section>
      </div>
    </div>
  );
}
