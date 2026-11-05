import { money } from './ui.tsx';

// How a pay month gets from the full timetable to Actual: each step that takes money away, with
// how many classes it covers. Used on the Pay page and the payslip.

export interface Breakdown {
  timetable: { sessions: number; minutes: number; pay: number };
  holidays: Array<{ name: string; sessions: number; minutes: number; pay: number }>;
  cancelled: { sessions: number; pay: number };
  lateCuts: { sessions: number; pay: number };
  notRecorded: { sessions: number; pay: number };
  toGo: { sessions: number; pay: number };
  adjustments: number;
  other: number;
  actual: number;
}

const classes = (n: number) => `${n} class${n === 1 ? '' : 'es'}`;
const hours = (m: number) => `${(m / 60).toFixed(1)} h`;

export function PayBreakdown({ b, currency }: { b: Breakdown; currency: string }) {
  const rows: Array<{ label: string; detail?: string; amount: number; tone?: 'bad' | 'warn' | 'faint'; strong?: boolean }> = [
    { label: 'Full timetable', detail: `${classes(b.timetable.sessions)} · ${hours(b.timetable.minutes)} at full pay`, amount: b.timetable.pay, strong: true },
    ...b.holidays.map((h) => ({ label: `Holiday: ${h.name}`, detail: `${classes(h.sessions)} · ${hours(h.minutes)} not paid`, amount: -h.pay, tone: 'bad' as const })),
    ...(b.cancelled.sessions ? [{ label: 'Other cancelled classes', detail: classes(b.cancelled.sessions), amount: -b.cancelled.pay, tone: 'bad' as const }] : []),
    ...(b.lateCuts.sessions ? [{ label: 'Late arrivals', detail: classes(b.lateCuts.sessions), amount: -b.lateCuts.pay, tone: 'bad' as const }] : []),
    ...(b.notRecorded.sessions ? [{ label: 'Not recorded yet', detail: `${classes(b.notRecorded.sessions)}: record them on the Review page to be paid`, amount: -b.notRecorded.pay, tone: 'warn' as const }] : []),
    ...(b.toGo.sessions ? [{ label: 'Still to come', detail: `${classes(b.toGo.sessions)} not taught yet`, amount: -b.toGo.pay, tone: 'faint' as const }] : []),
    ...(b.adjustments ? [{ label: 'Adjustments', amount: b.adjustments }] : []),
    ...(Math.abs(b.other) >= 0.01 ? [{ label: 'Other differences', detail: 'recorded minutes or approved amounts that differ from the timetable', amount: b.other, tone: 'faint' as const }] : []),
  ];
  return (
    <table className="breakdown">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.tone ?? ''}>
            <td>{r.strong ? <b>{r.label}</b> : r.label}{r.detail && <div className="faint xs">{r.detail}</div>}</td>
            <td className="num mono">{r.amount < 0 ? `−${money(-r.amount, currency)}` : r.strong ? money(r.amount, currency) : `+${money(r.amount, currency)}`}</td>
          </tr>
        ))}
        <tr className="total"><td><b>Actual</b></td><td className="num mono"><b>{money(b.actual, currency)}</b></td></tr>
      </tbody>
    </table>
  );
}
