import { Link } from 'react-router-dom';
import { useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Empty, ErrorNote, Kind, Loading, MaterialStatus, money, Notice, ProgressPill, SessionStatus } from '../ui.tsx';
import { formatDate } from '../../../shared/dates.ts';

const partLabel = (p: any) => (p ? `${p.code} ${p.title ?? ''}` : null);

export function Dashboard() {
  const { t, lang } = useI18n();
  const { data: d, error, loading, reload } = useApi<any>('/dashboard');
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !d) return <div className="page"><Loading rows={8} /></div>;
  if (!d) return null;
  const m = d.month;
  const activeClasses = d.progress.filter((p: any) => p.status === 'active');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{formatDate(d.today, lang, true)}</div>
          <h1>{d.todays.length ? `${d.todays.length} ${d.todays.length === 1 ? 'class' : 'classes'} today` : 'No classes today'}</h1>
          {d.next && (
            <p className="sub">
              {t('Up next')}: <b className="mono">{d.next.code}</b> {d.next.date === d.today ? 'at' : `on ${formatDate(d.next.date, lang)},`} <span className="mono">{d.next.start}</span>
              {d.next.part && <> — {partLabel(d.next.part)}</>}
            </p>
          )}
        </div>
        <div className="toolbar">
          <Link className="btn" to="/timetable">{t('Timetable')}</Link>
          {d.next && <Link className="btn primary" to={`/classes/${d.next.classId}`}>Open {d.next.code}</Link>}
        </div>
      </div>

      {d.proposals.length > 0 && (
        <Notice tone="warn">
          <b>Schedule changes waiting for your review:</b>{' '}
          {d.proposals.map((p: any, i: number) => <span key={p.id}>{i > 0 && ', '}<Link to={`/classes/${p.class_id}/plan`}>{p.code}</Link> ({p.reason})</span>)}
        </Notice>
      )}

      <div className="figures">
        <div className="figure"><span className="eyebrow">{t('Sessions this month')}</span><span className="value">{m?.taughtSessions ?? 0}<small> taught · {m?.plannedSessions ?? 0} ahead</small></span></div>
        <div className="figure"><span className="eyebrow">{t('Hours this month')}</span><span className="value">{((m?.taughtMinutes ?? 0) / 60).toFixed(1)}<small> h</small></span></div>
        <div className="figure"><span className="eyebrow">{t('Estimated pay')}</span><span className="value">{money(m?.estimatedTotal ?? 0, d.currency)}</span><span className="faint xs">+ {money(m?.expected ?? 0, d.currency)} expected if planned sessions run</span></div>
        <div className="figure"><span className="eyebrow">{t('Students at risk')}</span><span className="value">{d.atRiskTotal}<small> across {activeClasses.length} classes</small></span></div>
      </div>

      <div className="grid side">
        <div className="stack" style={{ gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><h2>{t('Teaching today')}</h2><span className="faint small">{formatDate(d.today, lang)}</span></div>
            {d.todays.length ? (
              <ul className="ledger">
                {d.todays.map((s: any) => (
                  <li key={s.id}>
                    <span className="swatch" style={{ background: s.color }} />
                    <span className="when">{s.start}–{s.end}</span>
                    <div className="grow stack" style={{ gap: 4 }}>
                      <div className="row"><Link to={`/classes/${s.classId}`} className="mono" style={{ fontWeight: 600 }}>{s.code}</Link><Kind kind={s.kind} /><SessionStatus status={s.status} />{s.checkpoint && <span className="marker small">{s.checkpoint}</span>}</div>
                      <div className="small">{s.part ? partLabel(s.part) : s.note ?? s.activity.replace('_', ' ')}</div>
                      {s.materials.length > 0 && <div className="row small">{s.materials.map((mat: any) => <span key={mat.id} className="row" style={{ gap: 4 }}>{mat.title} <MaterialStatus status={mat.status} /></span>)}</div>}
                    </div>
                    {s.status === 'planned' && <Link className="btn sm" to={`/classes/${s.classId}/plan?session=${s.id}`}>{t('Mark taught')}</Link>}
                  </li>
                ))}
              </ul>
            ) : <Empty title="Nothing on the timetable today">{d.next ? <>Next class: {d.next.code} on <D date={d.next.date} />.</> : 'Generate a term plan for a class to fill the timetable.'}</Empty>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('Class progress')}</h2><Link to="/classes" className="small">All classes</Link></div>
            {d.progress.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Class</th><th>Status</th><th>Taught / planned</th><th>{t('Next lesson')}</th><th /></tr></thead>
                  <tbody>
                    {d.progress.map((p: any) => (
                      <tr key={p.classId}>
                        <td><span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: p.color }} /><Link className="mono" to={`/classes/${p.classId}`}>{p.code}</Link></span><div className="faint xs">{p.courseName}</div></td>
                        <td><ProgressPill status={p.progress.status} reason={p.progress.reason} /></td>
                        <td style={{ minWidth: 150 }}>
                          <div className="progress-track" title={`${p.progress.actual} taught, ${p.progress.expected} planned by today, ${p.progress.totalParts} in total`}>
                            <div className="bar" style={{ width: `${(p.progress.actual / Math.max(1, p.progress.totalParts)) * 100}%` }} />
                            <div className="plan" style={{ left: `${(p.progress.expected / Math.max(1, p.progress.totalParts)) * 100}%` }} />
                          </div>
                          <div className="mono xs faint" style={{ marginTop: 4 }}>{p.progress.actual} / {p.progress.expected} of {p.progress.totalParts}</div>
                        </td>
                        <td className="small">{p.nextPart ? `${p.nextPart.code} ${p.nextPart.title ?? p.nextPart.lessonTitle}` : '—'}</td>
                        <td>{p.unrecorded > 0 && <Link to={`/classes/${p.classId}/plan`} className="pill warn">{p.unrecorded} to record</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty title="No active classes" action={<Link className="btn" to="/classes">Create a class</Link>} />}
          </section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><h2>{t('Materials to prepare')}</h2><span className="faint small">next 7 days</span></div>
            {d.notReady.length ? (
              <ul className="ledger">
                {d.notReady.slice(0, 10).map((mat: any) => (
                  <li key={`${mat.id}-${mat.sessionId}`}>
                    <span className="when"><D date={mat.date} /></span>
                    <div className="grow"><div className="small"><b className="mono">{mat.code}</b> {mat.part} · {mat.title}</div></div>
                    <MaterialStatus status={mat.status} />
                  </li>
                ))}
              </ul>
            ) : <Empty title="Everything for the next 7 days is ready" />}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('Labs and exams ahead')}</h2><span className="faint small">next 3 weeks</span></div>
            {d.milestones.length ? (
              <ul className="ledger">
                {d.milestones.map((s: any) => (
                  <li key={s.id}>
                    <span className="when"><D date={s.date} /></span>
                    <div className="grow small"><b className="mono">{s.code}</b> {s.checkpoint ?? (s.activity === 'final' ? 'Final exam' : 'Midterm exam')}</div>
                    <span className="mono xs faint">{s.start}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No labs or exams in the next three weeks" />}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('Students at risk')}</h2><span className="faint small">{d.atRiskTotal}</span></div>
            {d.atRisk.length ? (
              <ul className="ledger">
                {d.atRisk.map((s: any) => (
                  <li key={s.enrollmentId}>
                    <div className="grow">
                      <div className="small"><Link to={`/classes/${s.classId}/grades`}>{s.nameKm ?? s.nameLatin}</Link> <span className="faint">{s.nameLatin}</span></div>
                      <div className="faint xs">{s.code} · {s.studentCode} · {s.reason}</div>
                    </div>
                    <span className="mono small">{s.total}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No students at risk right now">Based on the scores entered so far.</Empty>}
          </section>
        </div>
      </div>
    </div>
  );
}
