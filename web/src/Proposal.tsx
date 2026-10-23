import { api } from './api.ts';
import { D, Dialog, Kind, Notice, useAction } from './ui.tsx';

export interface Proposal {
  id: number;
  reason: string;
  status: string;
  changes: Array<{ sessionId: number; date: string; start: string; before: any; after: any; beforePart: string | null; afterPart: string | null; reasons: string[] }>;
  partShifts: Array<{ partId: number; part: string | null; oldDate: string | null; newDate: string | null }>;
  overflow: Array<string | null>;
  checkpointWarnings: string[];
}

const what = (x: any, part: string | null) => (x.status === 'cancelled' ? 'Cancelled' : x.activity !== 'lesson' ? (x.activity === 'buffer' ? 'Review / buffer' : x.activity.replace('_', ' ')) : part ?? 'Free lesson slot');

/** Shows the impact of a proposed schedule change. Nothing is applied until the teacher approves. */
export function ProposalReview({ proposal, onClose, onDone }: { proposal: Proposal; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const apply = () => run(() => api(`/proposals/${proposal.id}/apply`, { method: 'POST' }), 'Schedule updated. The original plan is kept for comparison.').then((r) => { if (r) onDone(); });
  const dismiss = () => run(() => api(`/proposals/${proposal.id}/dismiss`, { method: 'POST' }), 'Proposal dismissed. The schedule is unchanged.').then(() => onDone());
  return (
    <Dialog wide title="Review schedule changes" onClose={onClose} footer={
      <>
        <button className="btn" onClick={dismiss} disabled={busy}>Keep the current schedule</button>
        <button className="btn primary" onClick={apply} disabled={busy || proposal.status !== 'pending'}>Apply {proposal.changes.length} change{proposal.changes.length === 1 ? '' : 's'}</button>
      </>
    }>
      <p className="muted">{proposal.reason}. Completed and confirmed sessions are never changed.</p>
      {proposal.checkpointWarnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
      {proposal.overflow.length > 0 && <Notice tone="bad">{proposal.overflow.length} lesson part(s) no longer fit before the end of term: {proposal.overflow.join(', ')}. Add a make-up session or shorten the plan.</Notice>}
      {proposal.partShifts.length > 0 && (
        <section className="stack" style={{ gap: 6 }}>
          <h3>Lessons that change date</h3>
          <div className="table-wrap panel">
            <table className="table">
              <thead><tr><th>Lesson</th><th>Was</th><th>Now</th></tr></thead>
              <tbody>
                {proposal.partShifts.map((p) => (
                  <tr key={p.partId}><td>{p.part}</td><td className="mono">{p.oldDate ? <D date={p.oldDate} /> : 'not scheduled'}</td><td className="mono"><b>{p.newDate ? <D date={p.newDate} /> : 'not scheduled'}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="stack" style={{ gap: 6 }}>
        <h3>Sessions affected</h3>
        <div className="table-wrap panel">
          <table className="table">
            <thead><tr><th>Session</th><th>Before</th><th>After</th><th>Why</th></tr></thead>
            <tbody>
              {proposal.changes.map((c) => (
                <tr key={c.sessionId}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}><D date={c.date} /> {c.start}</td>
                  <td className="small"><Kind kind={c.before.kind} /> {what(c.before, c.beforePart)}{c.before.checkpoint && <> · {c.before.checkpoint}</>}</td>
                  <td className="small"><Kind kind={c.after.kind} /> <b>{what(c.after, c.afterPart)}</b>{c.after.checkpoint && <> · <span className="marker">{c.after.checkpoint}</span></>}</td>
                  <td className="faint xs">{c.reasons.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Dialog>
  );
}
