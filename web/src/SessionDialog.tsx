import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.ts';
import { D, Dialog, Field, Kind, Notice, SessionStatus, useAction } from './ui.tsx';
import { ProposalReview, type Proposal } from './Proposal.tsx';

export interface SessionLike {
  id: number;
  class_id?: number;
  classId?: number;
  code?: string;
  date: string;
  start?: string;
  end?: string;
  start_time?: string;
  end_time?: string;
  kind: string;
  kind_source?: string;
  status: string;
  part?: string | null;
  checkpoint?: string | null;
  note?: string | null;
  confirmed?: number;
  moved_from_id?: number | null;
  is_makeup?: number;
}

type Mode = 'view' | 'cancel' | 'move';

/** Actions for one scheduled session. Changes that affect the plan open a proposal for review. */
export function SessionDialog({ session, today, onClose, onChanged }: { session: SessionLike; today: string; onClose: () => void; onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>('view');
  const [reason, setReason] = useState('');
  const start = session.start ?? session.start_time ?? '';
  const end = session.end ?? session.end_time ?? '';
  const [move, setMove] = useState({ date: session.date, start, end });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [overlaps, setOverlaps] = useState<any[]>([]);
  const { busy, run } = useAction();
  const classId = session.classId ?? session.class_id;

  const after = (r: any, msg: string) => {
    if (!r) return;
    onChanged();
    if (r.overlaps?.length) setOverlaps(r.overlaps);
    if (r.proposal) setProposal(r.proposal);
    else if (!r.overlaps?.length) onClose();
    if (!r.proposal) setMode('view');
    void msg;
  };

  if (proposal) return <ProposalReview proposal={proposal} onClose={() => { setProposal(null); onClose(); }} onDone={() => { onChanged(); setProposal(null); onClose(); }} />;

  return (
    <Dialog title={<span className="row"><span className="mono">{session.code}</span><Kind kind={session.kind} /><SessionStatus status={session.status} /></span>} onClose={onClose}
      footer={mode === 'view' ? (
        <>
          {session.status === 'planned' && <button className="btn danger" onClick={() => setMode('cancel')}>Cancel session</button>}
          {session.status === 'planned' && <button className="btn" onClick={() => setMode('move')}>Move</button>}
          {(session.status === 'cancelled' || session.status === 'skipped') && <button className="btn" disabled={busy} onClick={() => run(() => api(`/sessions/${session.id}/restore`, { method: 'POST' }), 'Session restored').then((r) => after(r, ''))}>Restore session</button>}
          {session.status === 'planned' && session.date <= today && <Link className="btn primary" to={`/classes/${classId}/plan?session=${session.id}`} onClick={onClose}>Record what was taught</Link>}
          {session.status === 'planned' && <Link className="btn" to={`/classes/${classId}/attendance?session=${session.id}`} onClick={onClose}>Attendance</Link>}
          {session.status === 'completed' && <Link className="btn primary" to={`/classes/${classId}/attendance?session=${session.id}`} onClick={onClose}>Attendance</Link>}
        </>
      ) : mode === 'cancel' ? (
        <>
          <button className="btn" onClick={() => setMode('view')}>Back</button>
          <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/sessions/${session.id}/cancel`, { body: { reason } })).then((r) => after(r, 'cancelled'))}>Cancel and review impact</button>
        </>
      ) : (
        <>
          <button className="btn" onClick={() => setMode('view')}>Back</button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/sessions/${session.id}/move`, { body: move })).then((r) => after(r, 'moved'))}>Move and review impact</button>
        </>
      )}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="mono"><D date={session.date} year /> · {start}–{end}</div>
        {session.part && <div>{session.part}</div>}
        {session.checkpoint && <div><span className="marker">{session.checkpoint}</span></div>}
        {session.note && <div className="muted small">{session.note}</div>}
        {session.moved_from_id && <div className="faint small">Moved here from another date. The original session is kept as “moved”.</div>}
        {session.is_makeup ? <div className="faint small">Make-up session</div> : null}
      </div>
      {overlaps.length > 0 && <Notice tone="warn">Double-booked with {overlaps.map((o) => `${o.code} ${o.start}–${o.end}`).join(', ')}.</Notice>}

      {mode === 'view' && session.status === 'planned' && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            <span className="small muted">Session type:</span>
            <div className="seg">
              {(['lecture', 'practice', 'exam'] as const).map((k) => (
                <button key={k} className={session.kind === k ? 'on' : ''} disabled={busy} onClick={() => run(() => api(`/sessions/${session.id}`, { method: 'PUT', body: { kind: k } })).then((r) => after(r, ''))}>{k}</button>
              ))}
            </div>
            {session.kind_source === 'manual' && <button className="btn sm ghost" onClick={() => run(() => api(`/sessions/${session.id}`, { method: 'PUT', body: { kind: null } })).then((r) => after(r, ''))}>Use the class rule</button>}
          </div>
          <label className="check"><input type="checkbox" checked={!!session.confirmed} onChange={(e) => run(() => api(`/sessions/${session.id}`, { method: 'PUT', body: { confirmed: e.target.checked } })).then((r) => after(r, ''))} /> Confirmed — keep this session as it is when the plan is re-calculated</label>
        </div>
      )}
      {mode === 'cancel' && (
        <Field label="Reason" hint="Shown on the term plan. The lessons that follow are re-planned, and you approve the result before anything changes.">
          <input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. School event, teacher sick" />
        </Field>
      )}
      {mode === 'move' && (
        <div className="form-grid">
          <Field label="New date"><input id="move-date" type="date" value={move.date} onChange={(e) => setMove({ ...move, date: e.target.value })} /></Field>
          <Field label="Start"><input id="move-start" type="time" value={move.start} onChange={(e) => setMove({ ...move, start: e.target.value })} /></Field>
          <Field label="End"><input id="move-end" type="time" value={move.end} onChange={(e) => setMove({ ...move, end: e.target.value })} /></Field>
        </div>
      )}
    </Dialog>
  );
}
