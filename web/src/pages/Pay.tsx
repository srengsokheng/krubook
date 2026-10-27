import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePref } from '../prefs.ts';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
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
        <div className="figure"><span className="eyebrow">Earned</span><span className="value">{money(p.totals.total, cur)}</span></div>
        <div className="figure"><span className="eyebrow">Paid</span><span className="value">{money(p.totals.paid, cur)}</span></div>
        <div className="figure"><span className="eyebrow">Outstanding</span><span className="value">{money(outstanding, cur)}</span><span className="faint xs">{money(p.totals.approved, cur)} approved · {money(p.totals.estimated, cur)} not yet approved</span></div>
      </div>

      <TabBar tabs={TABS} value={tab} onChange={setTab} labels={{ months: 'By month', sessions: 'Sessions', rates: `Rates (${p.rates.filter((r: any) => r.active).length})`, adjustments: 'Adjustments' }} />
      {tab === 'months' && <Months p={p} reload={reload} />}
      {tab === 'sessions' && <Sessions year={year} currency={cur} />}
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
  const cur = p.currency;
  if (!p.months.length) return <div className="panel"><Empty title="No teaching recorded this year">Earnings appear once you record sessions as taught.</Empty></div>;
  const approve = (month: string) => run(() => api('/pay/statements', { body: { month } }), `${month} approved. Its amounts are now fixed.`).then(reload);
  return (
    <>
      <div className="panel table-wrap">
        <table className="table mobile-cards">
          <thead><tr><th>Pay month</th><th className="num">Hours</th><th className="num">Earned</th><th>Status</th><th className="no-print" /></tr></thead>
          <tbody>
            {p.months.map((m: any) => {
              const sts = p.statements.filter((s: any) => s.month === m.month);
              const canApprove = m.estimated !== 0 && m.month <= p.currentMonth;
              return (
                <tr key={m.month}>
                  <td data-label="Pay month"><span><PayMonth month={m.month} from={m.from} to={m.to} />{m.expected > 0 && <div className="faint xs mono">+ {money(m.expected, cur)} planned</div>}</span></td>
                  <td data-label="Hours" className="num">{(m.taughtMinutes / 60).toFixed(1)}</td>
                  <td data-label="Earned" className="num"><b>{money(m.total, cur)}</b></td>
                  <td data-label="Status">
                    <div className="row" style={{ gap: 6 }}>
                      {sts.map((s: any) => <button key={s.id} className="btn ghost sm" style={{ padding: 0 }} onClick={() => setOpen(s.id)}><Pill tone={s.status === 'paid' ? 'ok' : 'accent'}>{s.status === 'paid' ? `Paid ${money(s.paidAmount, cur)}` : `Approved ${money(s.total, cur)}`}</Pill></button>)}
                      {m.estimated !== 0 && <Pill tone="warn">{money(m.estimated, cur)} not approved</Pill>}
                    </div>
                  </td>
                  <td data-label="" className="no-print" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <span>{canApprove && <button className="btn sm primary" disabled={busy} onClick={() => approve(m.month)}>Approve</button>}{' '}
                    {sts.filter((s: any) => s.status === 'approved').map((s: any) => <Menu key={s.id} label="Statement" items={[{ label: 'Mark as paid…', onSelect: () => setPaying(s) }, { label: 'View sessions', onSelect: () => setOpen(s.id) }, { label: 'Undo approval', danger: true, onSelect: () => setUndo(s) }]} />)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint xs">Each pay month covers the teaching dates shown under it (change the pay period in Settings). Approving a month fixes its sessions, rates and amounts. Later rate changes then only affect months that are not approved.</p>
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
              <thead><tr><th>Date</th><th>Class</th><th className="num">Minutes</th><th>Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>{s.lines.map((l: any) => <tr key={l.sessionId}><td className="mono small"><D date={l.date} /> {l.start}</td><td className="mono">{l.code}</td><td className="num">{l.minutes}</td><td className="small">{l.rate}</td><td className="num">{money(l.amount, s.currency)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

function Sessions({ year, currency }: { year: string; currency: string }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = usePref<number>('pageSize.paySessions', 10);
  const { data, error, loading, reload } = useApi<any>(`/pay/lines?year=${year}&page=${page}&pageSize=${size}`);
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data?.total) return <div className="panel"><Empty title="No taught sessions this year" /></div>;
  return (
    <div className="panel">
      <div className="table-wrap">
        <table className="table mobile-cards">
          <thead><tr><th>Date</th><th>Class</th><th className="num">Minutes</th><th>Rate</th><th className="num">Amount</th><th>Status</th></tr></thead>
          <tbody>{data.items.map((l: any) => (
            <tr key={l.sessionId}>
              <td data-label="Date" className="mono small"><span><D date={l.date} /> {l.start}</span></td>
              <td data-label="Class" className="mono"><span>{l.code}{l.isMakeup && <span className="pill" style={{ marginLeft: 6 }}>make-up</span>}</span></td>
              <td data-label="Minutes" className="num">{l.minutes}</td>
              <td data-label="Rate" className="small">{l.rate ?? <Pill tone="warn">no rate</Pill>}</td>
              <td data-label="Amount" className="num">{money(l.amount, currency)}</td>
              <td data-label="Status">{l.statementStatus ? <Pill tone={l.statementStatus === 'paid' ? 'ok' : 'accent'}>{l.statementStatus}</Pill> : <span className="faint small">estimate</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Pager meta={data} onPage={setPage} onSize={(s) => { setSize(s); setPage(1); }} noun="sessions" />
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
