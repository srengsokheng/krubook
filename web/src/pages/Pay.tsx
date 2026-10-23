import { useState } from 'react';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Empty, ErrorNote, Field, Icon, Loading, Notice, money, useAction, useToast } from '../ui.tsx';

export function Pay() {
  const { t } = useI18n();
  const toast = useToast();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const { data: p, error, loading, reload } = useApi<any>(`/pay?year=${year}`);
  const { data: classes } = useApi<any[]>('/classes');
  const { data: courses } = useApi<any[]>('/courses');
  const [rate, setRate] = useState({ scope: 'default', classId: 0, courseId: 0, mode: 'hourly', amount: 12, effectiveFrom: `${year}-01-01` });
  const [adj, setAdj] = useState({ month: '', amount: 0, note: '' });
  const [pay, setPay] = useState({ month: '', amount: 0, status: 'paid', paidOn: '', note: '' });
  const { busy, run } = useAction();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !p) return <div className="page"><Loading rows={8} /></div>;
  if (!p) return null;
  const cur = p.currency;
  const tot = p.months.reduce((s: any, m: any) => ({ n: s.n + m.taughtSessions, min: s.min + m.taughtMinutes, est: s.est + m.estimatedTotal, paid: s.paid + m.paid, exp: s.exp + m.expected }), { n: 0, min: 0, est: 0, paid: 0, exp: 0 });
  const scopeName = (r: any) => r.classId ? `Class ${classes?.find((c) => c.id === r.classId)?.code ?? r.classId}` : r.courseId ? `Course ${courses?.find((c) => c.id === r.courseId)?.code ?? r.courseId}` : 'Default';

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Pay')}</h1><p className="sub">Calculated only from sessions you recorded as taught. Planned sessions appear as “expected”, never as earned.</p></div>
        <div className="toolbar">
          <select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 100 }}>{[0, 1, 2].map((d) => { const y = String(new Date().getFullYear() - d); return <option key={y}>{y}</option>; })}</select>
          <button className="btn" onClick={() => download(`/export/pay/${year}`).catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Payment report</button>
          <button className="btn" onClick={() => window.print()}><Icon name="printer" />Print</button>
        </div>
      </div>
      {p.unrecorded > 0 && <Notice tone="warn">{p.unrecorded} past session(s) this year have no teaching record, so they are not counted. Record them from each class’s term plan.</Notice>}
      {!p.rates.length && <Notice tone="warn">No pay rate is set, so amounts show as 0. Add a default rate below.</Notice>}

      <div className="figures">
        <div className="figure"><span className="eyebrow">Sessions taught</span><span className="value">{tot.n}</span></div>
        <div className="figure"><span className="eyebrow">Hours taught</span><span className="value">{(tot.min / 60).toFixed(1)}</span></div>
        <div className="figure"><span className="eyebrow">Estimated earned</span><span className="value">{money(tot.est, cur)}</span></div>
        <div className="figure"><span className="eyebrow">Marked paid</span><span className="value">{money(tot.paid, cur)}</span><span className="faint xs">{money(tot.est - tot.paid, cur)} not yet paid</span></div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Monthly summary {year}</h2></div>
        {p.months.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Month</th><th className="num">Taught</th><th className="num">Hours</th><th className="num">Make-up</th><th className="num">Earned</th><th className="num">Adjustments</th><th className="num">Estimated total</th><th className="num">Confirmed</th><th className="num">Paid</th><th className="num">Expected (planned)</th></tr></thead>
              <tbody>{p.months.map((m: any) => (
                <tr key={m.month}>
                  <td className="mono">{m.month}</td><td className="num">{m.taughtSessions}</td><td className="num">{(m.taughtMinutes / 60).toFixed(1)}</td><td className="num">{m.makeupSessions || ''}</td>
                  <td className="num">{money(m.earned, cur)}</td><td className="num">{m.adjustments ? money(m.adjustments, cur) : ''}</td><td className="num"><b>{money(m.estimatedTotal, cur)}</b></td>
                  <td className="num">{m.confirmed ? money(m.confirmed, cur) : ''}</td><td className="num">{m.paid ? money(m.paid, cur) : ''}</td><td className="num faint">{m.expected ? money(m.expected, cur) : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty title="No recorded teaching this year" />}
      </section>

      <div className="grid three no-print">
        <section className="panel">
          <div className="panel-head"><h2>Rates</h2></div>
          <div className="panel-body stack">
            {p.rates.length > 0 && <ul className="ledger panel">{p.rates.map((r: any) => <li key={r.id}><div className="grow small">{scopeName(r)} · <b className="mono">{money(r.amount, r.currency)}</b> {r.mode === 'hourly' ? 'per hour' : 'per session'}<div className="faint xs">from <D date={r.effectiveFrom} year /></div></div><button className="btn sm ghost" aria-label="Remove rate" onClick={() => run(() => api(`/rates/${r.id}`, { method: 'DELETE' })).then(reload)}><Icon name="trash" /></button></li>)}</ul>}
            <p className="faint xs">The most specific rate wins: class, then course, then default.</p>
            <div className="form-grid">
              <Field label="Applies to"><select id="r-scope" value={rate.scope} onChange={(e) => setRate({ ...rate, scope: e.target.value })}><option value="default">All classes</option><option value="course">A course</option><option value="class">A class</option></select></Field>
              {rate.scope === 'course' && <Field label="Course"><select id="r-course" value={rate.courseId} onChange={(e) => setRate({ ...rate, courseId: +e.target.value })}><option value={0}>Choose…</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>}
              {rate.scope === 'class' && <Field label="Class"><select id="r-class" value={rate.classId} onChange={(e) => setRate({ ...rate, classId: +e.target.value })}><option value={0}>Choose…</option>{classes?.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>}
              <Field label="Basis"><select id="r-mode" value={rate.mode} onChange={(e) => setRate({ ...rate, mode: e.target.value })}><option value="hourly">Per hour</option><option value="per_session">Per session</option></select></Field>
              <Field label={`Amount (${cur})`}><input id="r-amount" type="number" min={0} step="0.5" value={rate.amount} onChange={(e) => setRate({ ...rate, amount: +e.target.value })} /></Field>
              <Field label="From"><input id="r-from" type="date" value={rate.effectiveFrom} onChange={(e) => setRate({ ...rate, effectiveFrom: e.target.value })} /></Field>
            </div>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api('/rates', { body: { ...rate, classId: rate.scope === 'class' ? rate.classId : null, courseId: rate.scope === 'course' ? rate.courseId : null } }), 'Rate added').then(reload)}>Add rate</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Adjustments</h2></div>
          <div className="panel-body stack">
            {p.adjustments.length > 0 && <ul className="ledger panel">{p.adjustments.map((a: any) => <li key={a.id}><span className="mono when">{a.month}</span><span className="grow small">{a.note}</span><span className="mono small">{money(a.amount, cur)}</span><button className="btn sm ghost" aria-label="Remove" onClick={() => run(() => api(`/pay/adjustments/${a.id}`, { method: 'DELETE' })).then(reload)}><Icon name="trash" /></button></li>)}</ul>}
            <div className="form-grid">
              <Field label="Month"><input id="a-month" type="month" value={adj.month} onChange={(e) => setAdj({ ...adj, month: e.target.value })} /></Field>
              <Field label="Amount" hint="Negative to deduct."><input id="a-amount" type="number" step="0.5" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: +e.target.value })} /></Field>
            </div>
            <Field label="Reason (required)"><input id="a-note" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Exam invigilation" /></Field>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !adj.month || !adj.note} onClick={() => run(() => api('/pay/adjustments', { body: adj }), 'Adjustment added').then(() => { setAdj({ month: '', amount: 0, note: '' }); reload(); })}>Add adjustment</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Payments received</h2></div>
          <div className="panel-body stack">
            {p.payments.length > 0 && <ul className="ledger panel">{p.payments.map((x: any) => <li key={x.id}><span className="mono when">{x.month}</span><span className="grow small">{x.status === 'paid' ? 'Paid' : 'Confirmed'}{x.paid_on && <> on <D date={x.paid_on} /></>}{x.note && ` · ${x.note}`}</span><span className="mono small">{money(x.amount, cur)}</span><button className="btn sm ghost" aria-label="Remove" onClick={() => run(() => api(`/pay/payments/${x.id}`, { method: 'DELETE' })).then(reload)}><Icon name="trash" /></button></li>)}</ul>}
            <div className="form-grid">
              <Field label="For month"><input id="p-month" type="month" value={pay.month} onChange={(e) => setPay({ ...pay, month: e.target.value })} /></Field>
              <Field label="Amount"><input id="p-amount" type="number" min={0} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: +e.target.value })} /></Field>
              <Field label="Status"><select id="p-status" value={pay.status} onChange={(e) => setPay({ ...pay, status: e.target.value })}><option value="confirmed">Confirmed by school</option><option value="paid">Paid</option></select></Field>
              <Field label="Paid on"><input id="p-on" type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></Field>
            </div>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !pay.month} onClick={() => run(() => api('/pay/payments', { body: { ...pay, paidOn: pay.paidOn || null } }), 'Payment recorded').then(() => { setPay({ month: '', amount: 0, status: 'paid', paidOn: '', note: '' }); reload(); })}>Record payment</button>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Taught sessions</h2><span className="faint small">{p.lines.length}</span></div>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>Date</th><th>Class</th><th className="num">Minutes</th><th>Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>{p.lines.map((l: any) => <tr key={l.id}><td className="mono small"><D date={l.date} /> {l.start}</td><td className="mono">{l.code}{l.isMakeup && <span className="pill" style={{ marginLeft: 6 }}>make-up</span>}</td><td className="num">{l.minutes}</td><td className="small">{l.rate ?? <span className="pill warn">no rate</span>}</td><td className="num">{money(l.amount, cur)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
