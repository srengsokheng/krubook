import { Link } from 'react-router-dom';
import { useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Empty, ErrorNote, Icon, Kind, Loading, MaterialStatus, money, PayMonth, plural, ProgressPill, SessionStatus } from '../ui.tsx';
import { formatDate } from '../../../shared/dates.ts';
import { CheckIn } from '../CheckIn.tsx';

const partLabel = (p: any) => (p ? `${p.code} ${p.title ?? ''}` : null);

// The dashboard answers "what do I act on now?": today's classes and anything overdue first;
// progress and pay are summaries that link to their own pages.
export function Dashboard() {
  const { t, lang } = useI18n();
  const { data: d, error, loading, reload } = useApi<any>('/dashboard');
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !d) return <div className="page"><Loading rows={8} /></div>;
  if (!d) return null;
  const m = d.month;
  const unrecorded = d.progress.filter((p: any) => p.unrecorded > 0);
  const behind = d.progress.filter((p: any) => p.progress.status === 'behind');
  const attention = [
    ...d.proposals.map((p: any) => ({ key: `p${p.id}`, to: `/classes/${p.class_id}/plan`, text: <><b className="mono">{p.code}</b> schedule change to review</>, tone: 'warn' })),
    ...(unrecorded.length ? [{ key: 'unrec', to: '/review', text: <>{plural(unrecorded.reduce((n: number, p: any) => n + p.unrecorded, 0), 'past session needs', 'past sessions need')} a decision ({unrecorded.map((p: any) => p.code).join(', ')})</>, tone: 'warn' }] : []),
    ...(d.notReady.length ? [{ key: 'mat', to: `/classes/${d.notReady[0].classId}`, text: <>{d.notReady.length} material{d.notReady.length > 1 ? 's' : ''} not ready for this week</>, tone: 'warn' }] : []),
    ...(d.atRiskTotal ? [{ key: 'risk', to: `/classes/${d.atRisk[0].classId}/grades`, text: <>{d.atRiskTotal} student{d.atRiskTotal > 1 ? 's' : ''} at risk of failing</>, tone: 'bad' }] : []),
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{formatDate(d.today, lang, true)}</div>
          <h1>{d.todays.length ? `${d.todays.length} ${d.todays.length === 1 ? 'class' : 'classes'} today` : 'No classes today'}</h1>
          {d.next && <p className="sub">{t('Up next')}: <b className="mono">{d.next.code}</b> {d.next.date === d.today ? '' : formatDate(d.next.date, lang)} <span className="mono">{d.next.start}</span>{d.next.part && <> · {partLabel(d.next.part)}</>}</p>}
        </div>
        {d.next && <Link className="btn primary" to={`/classes/${d.next.classId}`}>Open {d.next.code}</Link>}
      </div>

      <div className="grid side">
        <div className="stack" style={{ gap: 20 }}>
          <section className="panel">
            <div className="panel-head"><h2>{t('Teaching today')}</h2></div>
            {d.todays.length ? (
              <ul className="ledger">
                {d.todays.map((s: any) => (
                  <li key={s.id}>
                    <span className="swatch" style={{ background: s.color }} />
                    <span className="when">{s.start}–{s.end}</span>
                    <div className="grow stack" style={{ gap: 4 }}>
                      <div className="row"><Link to={`/classes/${s.classId}`} className="mono" style={{ fontWeight: 600 }}>{s.code}</Link><Kind kind={s.kind} />{s.status !== 'planned' && <SessionStatus status={s.status} />}{s.checkpoint && <span className="marker small">{s.checkpoint}</span>}</div>
                      <div className="small muted">{s.part ? partLabel(s.part) : s.note ?? s.activity.replace('_', ' ')}</div>
                      {s.materials.some((x: any) => x.status !== 'ready') && <div className="row small">{s.materials.filter((x: any) => x.status !== 'ready').map((x: any) => <span key={x.id} className="row" style={{ gap: 4 }}>{x.title} <MaterialStatus status={x.status} /></span>)}</div>}
                    </div>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {(s.status === 'planned' || s.status === 'completed') && <CheckIn sessionId={s.id} start={s.start} date={s.date} today={d.today} value={s.checkin} />}
                      {s.status === 'planned' && <Link className="btn sm" to={`/classes/${s.classId}/plan?session=${s.id}`}>{t('Mark taught')}</Link>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty title="Nothing scheduled today">{d.next ? <>Next: {d.next.code} on <D date={d.next.date} />.</> : 'Generate a term plan for a class to fill the timetable.'}</Empty>}
          </section>

          {attention.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Needs attention</h2></div>
              <ul className="ledger">
                {attention.map((a) => (
                  <li key={a.key} style={{ alignItems: 'center' }}>
                    <span className="dot" style={{ background: a.tone === 'bad' ? 'var(--bad)' : 'var(--warn)' }} />
                    <span className="grow small">{a.text}</span>
                    <Link className="btn sm ghost" to={a.to}>Open<Icon name="right" /></Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <div className="panel-head"><h2>{t('Class progress')}</h2>{behind.length > 0 && <span className="pill bad">{behind.length} behind</span>}</div>
            {d.progress.length ? (
              <ul className="ledger">
                {d.progress.map((p: any) => (
                  <li key={p.classId} style={{ alignItems: 'center' }}>
                    <span className="dot" style={{ background: p.color }} />
                    <Link className="mono" to={`/classes/${p.classId}`} style={{ minWidth: 56, fontWeight: 600 }}>{p.code}</Link>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="progress-track" title={p.progress.reason}>
                        <div className="bar" style={{ width: `${(p.progress.actual / Math.max(1, p.progress.totalParts)) * 100}%` }} />
                        <div className="plan" style={{ left: `${(p.progress.expected / Math.max(1, p.progress.totalParts)) * 100}%` }} />
                      </div>
                      <div className="faint xs" style={{ marginTop: 4 }}>Next: {p.nextPart ? `${p.nextPart.code} ${p.nextPart.title ?? p.nextPart.lessonTitle}` : 'all lessons covered'}</div>
                    </div>
                    <ProgressPill status={p.progress.status} reason={p.progress.reason} />
                  </li>
                ))}
              </ul>
            ) : <Empty title="No active classes" action={<Link className="btn" to="/classes">Create a class</Link>} />}
          </section>
        </div>

        <div className="stack" style={{ gap: 20 }}>
          <section className="panel">
            <div className="panel-head"><h2>Coming up</h2><span className="faint small">3 weeks</span></div>
            {d.milestones.length ? (
              <ul className="ledger">
                {d.milestones.slice(0, 8).map((s: any) => (
                  <li key={s.id}>
                    <span className="when"><D date={s.date} /></span>
                    <div className="grow small"><b className="mono">{s.code}</b> {s.checkpoint ?? (s.activity === 'final' ? 'Final exam' : 'Midterm exam')}</div>
                  </li>
                ))}
              </ul>
            ) : <div className="panel-body faint small">No labs or exams in the next three weeks.</div>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>This pay month</h2><Link className="small" to="/pay">Pay</Link></div>
            {m && <div className="panel-body" style={{ paddingBottom: 0 }}><PayMonth month={m.month} from={m.from} to={m.to} /></div>}
            <dl className="kv panel-body">
              <dt>Sessions taught</dt><dd className="mono">{m?.taughtSessions ?? 0} <span className="faint">· {m?.plannedSessions ?? 0} still planned</span></dd>
              <dt>Hours</dt><dd className="mono">{((m?.taughtMinutes ?? 0) / 60).toFixed(1)}</dd>
              <dt>Earned so far</dt><dd className="mono">{money(m?.total ?? 0, d.currency)}{m?.deductions > 0 && <span className="faint"> · −{money(m.deductions, d.currency)} late</span>}</dd>
              <dt>Expected</dt><dd className="mono">{money(m?.expectedTotal ?? 0, d.currency)} <span className="faint">· {((m?.scheduledMinutes ?? 0) / 60).toFixed(1)} h scheduled</span></dd>
            </dl>
          </section>

          {d.atRisk.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>{t('Students at risk')}</h2><span className="faint small">{d.atRiskTotal}</span></div>
              <ul className="ledger">
                {d.atRisk.slice(0, 5).map((s: any) => (
                  <li key={s.enrollmentId}>
                    <div className="grow small"><Link to={`/classes/${s.classId}/grades`}>{s.nameKm ?? s.nameLatin}</Link> <span className="faint xs mono">{s.code}</span></div>
                    <span className="mono small">{s.total}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
