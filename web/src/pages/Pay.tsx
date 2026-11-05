import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePref } from '../prefs.ts';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { PayBreakdown } from '../PayBreakdown.tsx';
import { EditCheckIn } from '../CheckIn.tsx';
import { Fragment } from 'react';
import { Confirm, D, Dialog, Empty, ErrorNote, Field, Icon, Loading, Menu, Notice, Pager, Pill, PayMonth, TabBar, money, plural, useAction, useTab, useToast } from '../ui.tsx';

const TABS = ['months', 'sessions', 'rates', 'adjustments'] as const;
type Tab = (typeof TABS)[number];
export function Pay() {
  const { t } = useI18n();
  const toast = useToast();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [tab, setTab] = useTab(TABS, 'months');
  const { data: p, error, loading, reload } = useApi<any>(`/pay?year=${year}`);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !p) return <div className="page"><Loading rows={8} /></div>;
  if (!p) return null;
  const cur = p.currency;
  const outstanding = Math.round((p.totals.estimated + p.totals.approved) * 100) / 100;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Pay')}</h1>
        <div className="toolbar">
          <select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 96 }}>{[0, 1, 2].map((d) => { const y = String(new Date().getFullYear() - d); return <option key={y}>{y}</option>; })}</select>
          <Menu label="Export" items={[{ label: 'Payment report (Excel)', onSelect: () => download(`/export/pay/${year}`).catch((e) => toast(e.message, 'bad')) }, { label: 'Print this page', onSelect: () => window.print() }]} />
        </div>
      </div>

      {!p.rates.some((r: any) => r.active) && <Notice tone="warn">No active pay rate, so earnings show as 0. <a href="#rates" onClick={(e) => { e.preventDefault(); setTab('rates'); }}>Add a rate</a></Notice>}
      {p.unrated > 0 && p.rates.some((r: any) => r.active) && <Notice tone="warn">{p.unrated} taught session(s) have no matching rate.</Notice>}
      {p.unrecorded > 0 && <Notice tone="info">{plural(p.unrecorded, 'past session has', 'past sessions have')} no teaching record yet and {p.unrecorded === 1 ? 'is' : 'are'} not counted. <Link to="/review">Review them</Link></Notice>}

      <div className="figures">
        <div className="figure"><span className="eyebrow">Hours taught</span><span className="value">{(p.totals.taughtMinutes / 60).toFixed(1)}</span><span className="faint xs">{p.totals.taughtSessions} sessions</span></div>
        <div className="figure"><span className="eyebrow">Earned</span><span className="value">{money(p.totals.total, cur)}</span>{(p.totals.lateSessions > 0 || p.totals.holidayPay > 0) && <span className="faint xs">{[p.totals.holidayPay > 0 ? `holidays −${money(p.totals.holidayPay, cur)}` : '', p.totals.lateSessions > 0 ? `${plural(p.totals.lateSessions, 'late arrival', 'late arrivals')}${p.totals.deductions > 0 ? ` −${money(p.totals.deductions, cur)}` : ''}` : ''].filter(Boolean).join(' · ')}</span>}</div>
        <div className="figure"><span className="eyebrow">Paid</span><span className="value">{money(p.totals.paid, cur)}</span></div>
        <div className="figure"><span className="eyebrow">Outstanding</span><span className="value">{money(outstanding, cur)}</span><span className="faint xs">{money(p.totals.approved, cur)} approved · {money(p.totals.estimated, cur)} not yet approved</span></div>
      </div>

      <TabBar tabs={TABS} value={tab} onChange={setTab} labels={{ months: 'By month', sessions: 'Sessions', rates: `Rates (${p.rates.filter((r: any) => r.active).length})`, adjustments: 'Adjustments' }} />
      {tab === 'months' && <Months p={p} reload={reload} />}
      {tab === 'sessions' && <Sessions p={p} reload={reload} />}
      {tab === 'rates' && <Rates p={p} year={year} reload={reload} />}
      {tab === 'adjustments' && <Adjustments p={p} reload={reload} />}
    </div>
  );
}

function Months({ p, reload }: { p: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [paying, setPaying] = useState<any | null>(null);
  const [undo, setUndo] = useState<any | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const cur = p.currency;
  if (!p.months.length) return <div className="panel"><Empty title="No teaching recorded this year">Earnings appear once you record sessions as taught.</Empty></div>;
  const approve = (month: string) => run(() => api('/pay/statements', { body: { month } }), `${month} approved. Its amounts are now fixed.`).then(reload);
  return (
    <>
      <div className="panel table-wrap">
        <table className="table mobile-cards">
          <thead><tr><th>Pay month</th><th className="num">Expected</th><th className="num">Actual</th><th>Status</th><th className="no-print" /></tr></thead>
          <tbody>
            {p.months.map((m: any) => {
              const sts = p.statements.filter((s: any) => s.month === m.month);
              const canApprove = m.estimated !== 0 && m.month <= p.currentMonth;
              return (
                <Fragment key={m.month}>
                <tr>
                  <td data-label="Pay month"><span><PayMonth month={m.month} from={m.from} to={m.to} /></span></td>
                  <td data-label="Expected" className="num"><span>{money(m.expectedTotal, cur)}<div className="faint xs mono">{(m.scheduledMinutes / 60).toFixed(1)} h scheduled{m.adjustments ? ` · ${m.adjustments > 0 ? '+' : '−'}${money(Math.abs(m.adjustments), cur)} adj.` : ''}</div></span></td>
                  <td data-label="Actual" className="num"><span><b>{money(m.total, cur)}</b><div className="faint xs mono">{(m.taughtMinutes / 60).toFixed(1)} h worked{m.plannedSessions > 0 ? ` · ${m.plannedSessions} to go` : ''}{m.holidayPay > 0 ? ` · −${money(m.holidayPay, cur)} holidays` : ''}{m.deductions > 0 ? ` · −${money(m.deductions, cur)} late` : ''}</div><button type="button" className="btn ghost sm no-print" aria-expanded={why === m.month} onClick={() => setWhy(why === m.month ? null : m.month)}>{why === m.month ? 'Hide breakdown' : 'Why this amount'}</button></span></td>
                  <td data-label="Status">
                    <div className="row" style={{ gap: 6 }}>
                      {sts.map((s: any) => <button key={s.id} className="btn ghost sm" style={{ padding: 0 }} onClick={() => setOpen(s.id)}><Pill tone={s.status === 'paid' ? (s.paidAmount != null && Math.abs(s.paidAmount - s.total) >= 0.005 ? 'bad' : 'ok') : 'accent'} title={s.status === 'paid' && s.paidAmount != null && Math.abs(s.paidAmount - s.total) >= 0.005 ? `Approved ${money(s.total, cur)}; the school paid ${money(Math.abs(s.paidAmount - s.total), cur)} ${s.paidAmount < s.total ? 'less' : 'more'}` : undefined}>{s.status === 'paid' ? `Paid ${money(s.paidAmount, cur)}${s.paidAmount != null && Math.abs(s.paidAmount - s.total) >= 0.005 ? ` · ${s.paidAmount < s.total ? '−' : '+'}${money(Math.abs(s.paidAmount - s.total), cur)}` : ''}` : `Approved ${money(s.total, cur)}`}</Pill></button>)}
                      {m.estimated !== 0 && <Pill tone="warn">{money(m.estimated, cur)} not approved</Pill>}
                    </div>
                  </td>
                  <td data-label="" className="no-print" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <span>{canApprove && <button className="btn sm primary" disabled={busy} onClick={() => approve(m.month)}>Approve</button>}{' '}
                    {sts.filter((s: any) => s.status === 'approved').map((s: any) => <Menu key={s.id} label="Statement" items={[{ label: 'Mark as paid…', onSelect: () => setPaying(s) }, { label: 'View sessions', onSelect: () => setOpen(s.id) }, { label: 'Undo approval', danger: true, onSelect: () => setUndo(s) }]} />)}
                    {' '}<Link className="btn sm ghost" to={`/print/payslip/${m.month}`} target="_blank"><Icon name="printer" />Payslip</Link></span>
                  </td>
                </tr>
                {why === m.month && m.breakdown && <tr className="breakdown-row"><td colSpan={5}><PayBreakdown b={m.breakdown} currency={cur} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint xs">Expected is every session scheduled in the pay month at full rate, plus adjustments; holidays and cancelled sessions are left out. Actual is what you worked: sessions you checked in to or recorded as taught, minus cuts for arriving late. Each pay month covers the teaching dates shown under it (change the pay period in Settings). Approving a month fixes its sessions, rates and amounts.</p>
      {paying && <MarkPaid s={paying} onClose={() => setPaying(null)} onDone={reload} />}
      {undo && <Confirm title={`Undo the ${undo.month} approval?`} body="Its sessions go back to estimates and will use the current rates." confirmLabel="Undo approval" danger onConfirm={() => run(() => api(`/pay/statements/${undo.id}`, { method: 'DELETE' }), 'Approval undone').then(reload)} onClose={() => setUndo(null)} />}
      {open && <StatementDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MarkPaid({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ paidOn: new Date().toISOString().slice(0, 10), amount: String(s.total), note: '' });
  const { busy, run } = useAction();
  return (
    <Dialog title={`Mark ${s.month} as paid`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api(`/pay/statements/${s.id}/paid`, { body: { ...f, amount: f.amount === '' ? undefined : Number(f.amount) } }), 'Marked as paid').then((r) => { if (r) { onDone(); onClose(); } })}>Mark paid</button></>}>
      <p className="muted small">Approved total: <b className="mono">{money(s.total, s.currency)}</b>. A paid statement cannot be undone.</p>
      <div className="form-grid">
        <Field label="Paid on"><input id="mp-on" type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        <Field label="Amount received"><input id="mp-amt" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      </div>
      {f.amount !== '' && Math.abs(Number(f.amount) - s.total) >= 0.005 && <Notice tone="warn">That is {money(Math.abs(Number(f.amount) - s.total), s.currency)} {Number(f.amount) < s.total ? 'less' : 'more'} than approved. The month and its payslip will show the difference.</Notice>}
      <Field label="Note"><input id="mp-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. bank transfer" /></Field>
    </Dialog>
  );
}

function StatementDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: s } = useApi<any>(`/pay/statements/${id}`);
  return (
    <Dialog wide title={s ? `Statement ${s.month}` : 'Statement'} onClose={onClose}>
      {!s ? <Loading /> : (
        <>
          <dl className="kv">
            <dt>Status</dt><dd>{s.status === 'paid' ? <>Paid {money(s.paidAmount, s.currency)} on <D date={s.paidOn} year /></> : 'Approved, not paid'}</dd>
            <dt>Sessions</dt><dd className="mono">{s.sessions} · {(s.minutes / 60).toFixed(1)} h</dd>
            <dt>Earned</dt><dd className="mono">{money(s.earned, s.currency)}</dd>
            <dt>Adjustments</dt><dd className="mono">{money(s.adjustments, s.currency)}</dd>
            <dt>Total</dt><dd className="mono"><b>{money(s.total, s.currency)}</b></dd>
          </dl>
          <div className="table-wrap panel" style={{ maxHeight: '45vh', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Date</th><th>Class</th><th className="num">Minutes</th><th>Arrived</th><th>Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>{s.lines.map((l: any) => <tr key={l.sessionId}><td className="mono small"><D date={l.date} /> {l.start}</td><td className="mono">{l.code}</td><td className="num">{l.minutes}</td><td className="small"><Arrived l={l} currency={s.currency} /></td><td className="small">{l.rate}</td><td className="num">{money(l.amount, s.currency)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

// Sessions of one pay month (16th to 15th) or one calendar month, as a list or a calendar. Every
// class is shown, also those not paid (holidays, not recorded yet), and the arrival of any class
// that has taken place can be added or corrected (a forgotten check-in), unless its month is approved.
const STATE_LABEL: Record<string, string> = { worked: 'Worked', 'not held': 'Not held', planned: 'Planned', 'not recorded': 'Not recorded yet' };
const lastDay = (ym: string) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();

function Sessions({ p, reload: reloadPay }: { p: any; reload: () => void }) {
  const [basis, setBasis] = usePref<'pay' | 'calendar'>('view.payPeriod', 'pay');
  const [view, setView] = usePref<'list' | 'calendar'>('view.paySessions', 'list');
  const payMonths: any[] = p.months;
  const calMonths = Array.from({ length: 12 }, (_, i) => `${p.year}-${String(i + 1).padStart(2, '0')}`);
  const fallback = payMonths.find((m) => m.month === p.currentMonth)?.month ?? payMonths.at(-1)?.month ?? `${p.year}-01`;
  const [month, setMonth] = useState<string>(fallback);
  const pm = payMonths.find((m) => m.month === month);
  const period = basis === 'pay' ? (pm ? { from: pm.from, to: pm.to } : null) : { from: `${month}-01`, to: `${month}-${lastDay(month)}` };
  const { data, error, loading, reload } = useApi<any>(period ? `/pay/period?from=${period.from}&to=${period.to}` : null);
  const [editing, setEditing] = useState<any | null>(null);
  const toast = useToast();
  const cur = p.currency;
  const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const edit = (r: any) => { if (r.canEditArrival) setEditing(r); };

  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <div className="seg" role="group" aria-label="Period"><button className={basis === 'pay' ? 'on' : ''} onClick={() => setBasis('pay')}>Pay month</button><button className={basis === 'calendar' ? 'on' : ''} onClick={() => setBasis('calendar')}>Calendar month</button></div>
          <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}>
            {(basis === 'pay' ? payMonths.map((m) => m.month) : calMonths).map((m) => {
              const x = payMonths.find((y) => y.month === m);
              return <option key={m} value={m}>{monthName(m)}{basis === 'pay' && x ? ` · ${+x.from.slice(8)} ${new Date(`${x.from}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })} – ${+x.to.slice(8)} ${new Date(`${x.to}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}` : ''}</option>;
            })}
          </select>
        </div>
        <div className="seg" role="group" aria-label="View"><button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button><button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>Calendar</button></div>
      </div>
      {error ? <ErrorNote error={error} retry={reload} /> : !period ? <div className="panel"><Empty title="No pay month to show" /></div> : loading && !data ? <Loading /> : data && (
        <>
          <p className="small muted">
            <b className="mono">{data.totals.worked}</b> of {data.totals.sessions} classes worked · <b className="mono">{(data.totals.minutes / 60).toFixed(1)} h</b> · <b className="mono">{money(data.totals.amount, cur)}</b>
            {data.totals.late > 0 && <> · {plural(data.totals.late, 'late arrival', 'late arrivals')}{data.totals.lateCuts > 0 ? ` −${money(data.totals.lateCuts, cur)}` : ''}</>}
            {data.totals.notRecorded > 0 && <> · <span style={{ color: 'var(--warn)' }}>{data.totals.notRecorded} not recorded yet</span></>}
            <span className="faint"> · tap a class to add or correct your arrival time</span>
          </p>
          {view === 'list' ? <SessionList rows={data.rows} currency={cur} onEdit={edit} /> : <PayCalendar data={data} currency={cur} onEdit={edit} />}
        </>
      )}
      {editing && <EditCheckIn label={`${editing.code}, ${new Date(`${editing.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${editing.start}`} sessionId={editing.sessionId} start={editing.start} value={editing.checkin ? { time: editing.checkin, late: editing.late } : null}
        onClose={() => setEditing(null)} onDone={(r, msg) => { if (r) { if (msg) toast(msg); reload(); reloadPay(); } }} />}
    </div>
  );
}

function stateTone(r: any): 'ok' | 'warn' | 'bad' | undefined {
  if (r.state === 'worked') return r.late > 0 ? (r.cut > 0 ? 'bad' : 'warn') : 'ok';
  if (r.state === 'not recorded') return 'warn';
  return undefined;
}

function ArrivalButton({ r, currency, onEdit }: { r: any; currency: string; onEdit: (r: any) => void }) {
  const text = r.checkin ? `${r.checkin}${r.late > 0 ? ` · ${r.late} min late${r.cut > 0 ? ` −${money(r.cut, currency)}` : ''}` : ' · on time'}` : r.canEditArrival ? 'Add arrival' : '—';
  if (!r.canEditArrival) return <span className="faint small mono">{r.checkin ? text : '—'}</span>;
  return <button type="button" className="btn sm ghost" aria-label={`Arrival for ${r.code} on ${r.date} ${r.start}`} onClick={() => onEdit(r)}><Pill tone={r.checkin ? stateTone(r) : undefined}>{text}</Pill></button>;
}

function SessionList({ rows, currency, onEdit }: { rows: any[]; currency: string; onEdit: (r: any) => void }) {
  if (!rows.length) return <div className="panel"><Empty title="No classes in this period" /></div>;
  return (
    <div className="panel table-wrap">
      <table className="table mobile-cards">
        <thead><tr><th>Date</th><th>Class</th><th>Time</th><th>Status</th><th>Arrived</th><th className="num">Amount</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.sessionId} className={r.state === 'not held' ? 'is-dim' : ''}>
            <td data-label="Date" className="mono small"><D date={r.date} /></td>
            <td data-label="Class" className="mono">{r.code}</td>
            <td data-label="Time" className="mono small">{r.start}–{r.end}</td>
            <td data-label="Status" className="small"><span>{STATE_LABEL[r.state]}{r.reason ? <span className="faint">: {r.reason}</span> : ''}{r.statementStatus ? <> <Pill tone={r.statementStatus === 'paid' ? 'ok' : 'accent'}>{r.statementStatus}</Pill></> : ''}</span></td>
            <td data-label="Arrived"><ArrivalButton r={r} currency={currency} onEdit={onEdit} /></td>
            <td data-label="Amount" className="num">{r.state === 'worked' ? money(r.amount, currency) : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PayCalendar({ data, currency, onEdit }: { data: any; currency: string; onEdit: (r: any) => void }) {
  const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const dow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const start = add(data.from, -dow(data.from)), end = add(data.to, 6 - dow(data.to));
  const byDay = new Map<string, any[]>();
  for (const r of data.rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const days: string[] = [];
  for (let d = start; d <= end; d = add(d, 1)) days.push(d);
  return (
    <div className="panel paycal-wrap">
      <div className="paycal" role="grid" aria-label="Classes by day">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="paycal-head" role="columnheader">{d}</div>)}
        {days.map((d) => {
          const inside = d >= data.from && d <= data.to;
          const list = inside ? byDay.get(d) ?? [] : [];
          const dayTotal = list.filter((r) => r.state === 'worked').reduce((x, r) => x + r.amount, 0);
          return (
            <div key={d} role="gridcell" className={`paycal-day ${inside ? '' : 'out'} ${d === data.today ? 'today' : ''} ${list.length ? '' : 'empty'}`}>
              <div className="paycal-date"><span>{new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>{dayTotal > 0 && <span className="mono faint">{money(dayTotal, currency)}</span>}</div>
              {list.map((r) => (
                <button key={r.sessionId} type="button" className={`paycal-ev ${r.state.replace(' ', '-')} ${r.late > 0 ? 'late' : ''}`} disabled={!r.canEditArrival}
                  title={`${r.code} ${r.start}–${r.end}: ${STATE_LABEL[r.state]}${r.reason ? ` (${r.reason})` : ''}${r.canEditArrival ? '. Tap to add or correct your arrival.' : ''}`}
                  aria-label={`${r.code} ${r.date} ${r.start} ${STATE_LABEL[r.state]}${r.checkin ? `, arrived ${r.checkin}` : ''}`} onClick={() => onEdit(r)}>
                  <span className="mono"><b>{r.code}</b> {r.start}</span>
                  <span className="xs">{r.state === 'worked' ? (r.checkin ? (r.late > 0 ? `${r.checkin} · ${r.late} min late` : `${r.checkin} on time`) : 'no check-in') : r.state === 'not held' ? (r.reason?.startsWith('Holiday') ? r.reason.split(' (')[0] : 'Not held') : STATE_LABEL[r.state]}</span>
                  {r.state === 'worked' && <span className="mono xs">{money(r.amount, currency)}</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Rates({ p, year, reload }: { p: any; year: string; reload: () => void }) {
  const { data: classes } = useApi<any[]>('/classes');
  const { data: courses } = useApi<any[]>('/courses');
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const { run } = useAction();
  const scopeName = (r: any) => r.classId ? `Class ${classes?.find((c) => c.id === r.classId)?.code ?? r.classId}` : r.courseId ? `Course ${courses?.find((c) => c.id === r.courseId)?.code ?? r.courseId}` : 'All classes';
  return (
    <div className="stack">
      <div className="row between"><p className="faint small">The most specific active rate applies: class, then course, then all classes.</p><button className="btn primary" onClick={() => setEdit({ scope: 'default', mode: 'hourly', amount: '', effectiveFrom: `${year}-01-01`, currency: p.currency })}><Icon name="plus" />Add rate</button></div>
      {p.rates.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Applies to</th><th className="num">Rate</th><th>From</th><th>Status</th><th /></tr></thead>
            <tbody>{p.rates.map((r: any) => (
              <tr key={r.id} className={r.active ? '' : 'is-dim'}>
                <td>{scopeName(r)}</td>
                <td className="num mono">{money(r.amount, r.currency)} {r.mode === 'hourly' ? '/ h' : '/ session'}</td>
                <td className="mono small"><D date={r.effectiveFrom} year /></td>
                <td>{r.active ? <Pill tone="ok">active</Pill> : <Pill>inactive</Pill>}</td>
                <td style={{ textAlign: 'right' }}><Menu label="Edit" items={[
                  { label: 'Edit…', onSelect: () => setEdit({ ...r, scope: r.classId ? 'class' : r.courseId ? 'course' : 'default' }) },
                  { label: r.active ? 'Deactivate' : 'Reactivate', onSelect: () => run(() => api(`/rates/${r.id}`, { method: 'PUT', body: { active: !r.active } }), r.active ? 'Rate deactivated' : 'Rate reactivated').then(reload) },
                  { label: 'Delete…', danger: true, onSelect: () => setDel(r) },
                ]} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <div className="panel"><Empty title="No rates yet" /></div>}
      <LateRule rule={p.lateRule} onSaved={reload} />
      {edit && <RateForm r={edit} classes={classes ?? []} courses={courses ?? []} onClose={() => setEdit(null)} onDone={reload} />}
      {del && <Confirm title="Delete this rate?" body="Approved and paid months keep their amounts. Months not yet approved are re-estimated without it." confirmLabel="Delete" danger onConfirm={() => run(() => api(`/rates/${del.id}`, { method: 'DELETE' }), 'Rate deleted').then(reload)} onClose={() => setDel(null)} />}
    </div>
  );
}

function RateForm({ r, classes, courses, onClose, onDone }: { r: any; classes: any[]; courses: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ scope: r.scope, classId: r.classId ?? 0, courseId: r.courseId ?? 0, mode: r.mode, amount: String(r.amount ?? ''), effectiveFrom: r.effectiveFrom, currency: r.currency ?? 'USD' });
  const { busy, run } = useAction();
  const body = { mode: f.mode, amount: f.amount === '' ? '' : Number(f.amount), effectiveFrom: f.effectiveFrom, currency: f.currency, classId: f.scope === 'class' ? f.classId || null : null, courseId: f.scope === 'course' ? f.courseId || null : null };
  const save = () => run(() => (r.id ? api(`/rates/${r.id}`, { method: 'PUT', body }) : api('/rates', { body })), 'Rate saved').then((x) => { if (x) { onDone(); onClose(); } });
  return (
    <Dialog title={r.id ? 'Edit rate' : 'Add rate'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      {r.id && <p className="faint small">Changing a rate re-estimates months that are not approved yet.</p>}
      <div className="form-grid">
        <Field label="Applies to"><select id="r-scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="default">All classes</option><option value="course">One course</option><option value="class">One class</option></select></Field>
        {f.scope === 'course' && <Field label="Course"><select id="r-course" value={f.courseId} onChange={(e) => setF({ ...f, courseId: +e.target.value })}><option value={0}>Choose…</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>}
        {f.scope === 'class' && <Field label="Class"><select id="r-class" value={f.classId} onChange={(e) => setF({ ...f, classId: +e.target.value })}><option value={0}>Choose…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>}
        <Field label="Paid per"><select id="r-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="hourly">Hour</option><option value="per_session">Session</option></select></Field>
        <Field label="Amount"><input id="r-amount" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Currency"><input id="r-cur" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Starts"><input id="r-from" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function Adjustments({ p, reload }: { p: any; reload: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const { run } = useAction();
  return (
    <div className="stack">
      <div className="row between"><p className="faint small">Extra pay or deductions, such as invigilation. They are fixed once their month is approved.</p><button className="btn primary" onClick={() => setEdit({ month: p.currentMonth, amount: '', note: '' })}><Icon name="plus" />Add adjustment</button></div>
      {p.adjustments.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Month</th><th>Note</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>{p.adjustments.map((a: any) => (
              <tr key={a.id}>
                <td className="mono">{a.month}</td><td>{a.note}</td><td className="num mono">{money(a.amount, p.currency)}</td>
                <td style={{ textAlign: 'right' }}>{a.locked ? <span className="faint xs">in approved month</span> : <Menu label="Edit" items={[{ label: 'Edit…', onSelect: () => setEdit(a) }, { label: 'Delete…', danger: true, onSelect: () => setDel(a) }]} />}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <div className="panel"><Empty title="No adjustments this year" /></div>}
      {edit && <AdjustmentForm a={edit} onClose={() => setEdit(null)} onDone={reload} />}
      {del && <Confirm title="Delete this adjustment?" body={`${del.note} (${del.month})`} confirmLabel="Delete" danger onConfirm={() => run(() => api(`/pay/adjustments/${del.id}`, { method: 'DELETE' }), 'Adjustment deleted').then(reload)} onClose={() => setDel(null)} />}
    </div>
  );
}

function AdjustmentForm({ a, onClose, onDone }: { a: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ month: a.month, amount: String(a.amount ?? ''), note: a.note ?? '' });
  const { busy, run } = useAction();
  const body = { month: f.month, amount: f.amount === '' ? '' : Number(f.amount), note: f.note };
  return (
    <Dialog title={a.id ? 'Edit adjustment' : 'Add adjustment'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => (a.id ? api(`/pay/adjustments/${a.id}`, { method: 'PUT', body }) : api('/pay/adjustments', { body })), 'Adjustment saved').then((x) => { if (x) { onDone(); onClose(); } })}>Save</button></>}>
      <div className="form-grid">
        <Field label="Month"><input id="a-month" type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
        <Field label="Amount" hint="Negative to deduct."><input id="a-amount" type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      </div>
      <Field label="Reason"><input id="a-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Exam invigilation, 15 Sep" /></Field>
    </Dialog>
  );
}

function Arrived({ l, currency }: { l: any; currency: string }) {
  if (!l.checkin) return <span className="faint">{l.recorded ? '—' : ''}</span>;
  return (
    <span className="mono">
      {l.checkin}{' '}
      {l.late > 0 ? <Pill tone={l.deduction > 0 ? 'warn' : undefined} title={l.deduction > 0 ? `${money(l.deduction, currency)} cut for arriving late` : 'Not late enough to cut pay'}>{l.late} min late{l.deduction > 0 ? ` · −${money(l.deduction, currency)}` : ''}</Pill> : <span className="faint xs">on time</span>}
    </span>
  );
}

function LateRule({ rule, onSaved }: { rule: { steps: Array<{ afterMinutes: number; cutPercent: number }> }; onSaved: () => void }) {
  const [steps, setSteps] = useState(rule.steps.map((x) => ({ after: String(x.afterMinutes), cut: String(x.cutPercent) })));
  const { busy, run } = useAction();
  const body = { steps: steps.map((x) => ({ afterMinutes: Number(x.after), cutPercent: Number(x.cut) })) };
  const changed = JSON.stringify(body.steps) !== JSON.stringify(rule.steps);
  const edit = (i: number, k: 'after' | 'cut', v: string) => setSteps(steps.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const sorted = [...body.steps].filter((x) => Number.isFinite(x.afterMinutes)).sort((a, b) => a.afterMinutes - b.afterMinutes);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Late arrivals</h2></div>
      <div className="panel-body stack">
        <p className="faint small">Check in on the dashboard when you arrive. A session counts as worked once you check in (or record it as taught); arriving late cuts that session’s pay:</p>
        <div className="stack" style={{ gap: 8 }}>
          {steps.map((x, i) => (
            <div key={i} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span className="small">Over</span>
              <input aria-label={`Step ${i + 1} minutes late`} type="number" min={0} max={240} step={1} value={x.after} onChange={(e) => edit(i, 'after', e.target.value)} style={{ width: 68 }} />
              <span className="small">min late, cut</span>
              <input aria-label={`Step ${i + 1} percent cut`} type="number" min={1} max={100} step={1} value={x.cut} onChange={(e) => edit(i, 'cut', e.target.value)} style={{ width: 68 }} />
              <span className="small">%</span>
              <button className="btn sm ghost" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          {steps.length < 5 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps([...steps, { after: '', cut: '' }])}><Icon name="plus" />Add step</button>}
        </div>
        <p className="faint xs">{sorted.length ? `Up to ${sorted[0].afterMinutes} min late: no cut. ` : 'No steps: lateness is recorded but pay is not cut. '}The highest step reached applies; 100% means the session is unpaid. Approved months keep the amounts they were approved with.</p>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !changed} onClick={() => run(() => api('/settings', { method: 'PUT', body: { lateRule: body } }), 'Late-arrival rule saved').then((r) => { if (r) onSaved(); })}>Save</button>
      </div>
    </section>
  );
}
