import { useState } from 'react';
import { api } from './api.ts';
import { Dialog, Field, Icon, Pill, useAction, useToast } from './ui.tsx';

// The teacher's own check-in for a session: one tap on the day, or a time typed in afterwards.
// Lateness (minutes after the scheduled start) feeds the pay page.

export interface CheckInValue { time: string | null; late: number; locked?: boolean }

export function lateLabel(late: number) {
  return late > 0 ? `${late} min late` : 'on time';
}

export function CheckIn({ sessionId, start, date, today, value, onChanged }: { sessionId: number; start: string; date: string; today: string; value: CheckInValue | null; onChanged?: () => void }) {
  const [c, setC] = useState<CheckInValue | null>(value);
  const [editing, setEditing] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  if (date > today) return null;
  const done = (r: any, msg?: string) => {
    if (!r) return;
    setC(r.time ? { time: r.time, late: r.late, locked: r.locked } : null);
    if (msg) toast(msg);
    onChanged?.();
  };
  const tap = () => run(() => api(`/sessions/${sessionId}/checkin`, { body: {} })).then((r) => done(r, r && `Checked in at ${r.time}, ${lateLabel(r.late)}`));

  return (
    <>
      {c?.time ? (
        <button type="button" className="btn sm ghost" title="Change or remove your check-in" onClick={() => setEditing(true)}>
          <Pill tone={c.late > 0 ? 'warn' : 'ok'}><Icon name="clock" />In {c.time} · {lateLabel(c.late)}</Pill>
        </button>
      ) : date === today ? (
        <button type="button" className="btn sm" disabled={busy} onClick={tap}><Icon name="clock" />Check in</button>
      ) : (
        <button type="button" className="btn sm ghost" onClick={() => setEditing(true)}>Add arrival time</button>
      )}
      {editing && <EditCheckIn sessionId={sessionId} start={start} value={c} onClose={() => setEditing(false)} onDone={done} />}
    </>
  );
}

function EditCheckIn({ sessionId, start, value, onClose, onDone }: { sessionId: number; start: string; value: CheckInValue | null; onClose: () => void; onDone: (r: any, msg?: string) => void }) {
  const [time, setTime] = useState(value?.time ?? start);
  const { busy, run } = useAction();
  const late = Math.max(0, (+time.slice(0, 2) * 60 + +time.slice(3, 5)) - (+start.slice(0, 2) * 60 + +start.slice(3, 5)));
  return (
    <Dialog title="Your arrival" onClose={onClose} footer={value?.locked ? <button className="btn" onClick={onClose}>Close</button> : <>
      {value?.time && <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/sessions/${sessionId}/checkin`, { method: 'DELETE' })).then((r) => { onDone(r, 'Check-in removed'); if (r) onClose(); })}>Remove check-in</button>}
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !/^\d\d:\d\d$/.test(time)} onClick={() => run(() => api(`/sessions/${sessionId}/checkin`, { body: { time } })).then((r) => { onDone(r, r && `Arrival saved: ${r.time}, ${lateLabel(r.late)}`); if (r) onClose(); })}>Save</button>
    </>}>
      {value?.locked ? <p className="muted small">This session is on an approved pay statement, so its check-in ({value.time}) is fixed. Undo the approval on the Pay page to change it.</p> : (
        <>
          <Field label="Arrived at" hint={`The session starts at ${start}. ${/^\d\d:\d\d$/.test(time) ? `This is ${lateLabel(late)}.` : ''}`}>
            <input id="ci-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <p className="faint xs">Late minutes are deducted from pay according to the late-arrival rule on the Pay page.</p>
        </>
      )}
    </Dialog>
  );
}
