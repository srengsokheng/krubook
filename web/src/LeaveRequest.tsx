import { useEffect, useMemo, useState } from 'react';
import { useApi } from './api.ts';
import { usePref } from './prefs.ts';
import { Dialog, Field, Icon, Kind, Notice, useToast } from './ui.tsx';
import { DEFAULT_LEAVE_TEMPLATE, LEAVE_REASONS, leaveMessage } from '../../shared/leave.ts';
import { addDays, startOfWeek } from '../../shared/dates.ts';

// Ask for leave: choose the day and which of its classes, type or pick a reason, and KruBook writes
// the message in the teacher's usual format, ready to copy or send with Telegram. The name and the
// template are remembered for next time (Settings are not needed: "Edit template" is here).

type Cls = { id: number; code: string; start: string; end: string; kind: string; status: string };

export function LeaveRequest({ date: initialDate, sessionIds, onClose }: { date: string; sessionIds?: number[]; onClose: () => void }) {
  const [date, setDate] = useState(initialDate);
  const { data: week } = useApi<any>(`/timetable?from=${startOfWeek(date)}`);
  const { data: me } = useApi<any>('/auth/me');
  const [savedName, setSavedName] = usePref<string>('leave.name', '');
  const [template, setTemplate] = usePref<string>('leave.template', '');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<number[] | null>(sessionIds ?? null);
  const [editing, setEditing] = useState(false);
  const toast = useToast();

  const classes: Cls[] = useMemo(() => (week?.sessions ?? [])
    .filter((s: any) => s.date === date && s.status !== 'cancelled' && s.status !== 'moved')
    .map((s: any) => ({ id: s.id, code: s.code, start: s.start, end: s.end, kind: s.kind, status: s.status }))
    .sort((a: Cls, b: Cls) => a.start.localeCompare(b.start)), [week, date]);
  // Until the teacher picks, every class of the day is selected.
  const chosen = classes.filter((c) => (picked ?? classes.map((x) => x.id)).includes(c.id));
  useEffect(() => { if (!name && (savedName || me?.user?.name)) setName(savedName || me.user.name); }, [savedName, me, name]);

  const text = chosen.length && reason.trim() ? leaveMessage({ template, name, date, classes: chosen, reason }) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste it into your message'); }
    catch { toast('Select the text and copy it', 'bad'); }
    if (name.trim() && name !== savedName) setSavedName(name.trim());
  };
  const toggle = (id: number) => setPicked((p) => { const cur = p ?? classes.map((c) => c.id); return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; });

  return (
    <Dialog wide title="Ask for leave" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      {text && <a className="btn" href={`https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Send with Telegram</a>}
      <button className="btn primary" disabled={!text} onClick={() => void copy()}><Icon name="check" />Copy message</button>
    </>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Day"><input id="leave-date" type="date" value={date} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPicked(null); } }} /></Field>
          <Field label="Your name in the message"><input id="leave-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== savedName && setSavedName(name.trim())} /></Field>
        </div>
        <Field label="Classes">
          {!week ? <span className="faint small">Loading…</span> : classes.length ? (
            <div className="stack" style={{ gap: 4 }}>
              {classes.map((c) => (
                <label key={c.id} className="check small">
                  <input type="checkbox" aria-label={`Leave from ${c.code} ${c.start}`} checked={chosen.some((x) => x.id === c.id)} onChange={() => toggle(c.id)} />
                  <span className="mono">{c.start}–{c.end}</span> <b className="mono">{c.code}</b> <Kind kind={c.kind} />
                </label>
              ))}
            </div>
          ) : <span className="faint small">No classes on this day.</span>}
        </Field>
        <Field label="Reason (written after ដោយសារ)">
          <input id="leave-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. ខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)" />
        </Field>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {LEAVE_REASONS.map((r) => <button key={r.km} type="button" className={`btn sm ${reason === r.km ? 'primary' : ''}`} title={r.en} onClick={() => setReason(r.km)}>{r.km}</button>)}
        </div>
        {text ? (
          <Field label="Message">
            <textarea id="leave-text" readOnly rows={4} value={text} onFocus={(e) => e.currentTarget.select()} />
          </Field>
        ) : <Notice>{chosen.length ? 'Add a reason to see the message.' : 'Choose at least one class.'}</Notice>}
        <div>
          <button type="button" className="btn ghost sm" onClick={() => setEditing(!editing)}>{editing ? 'Hide template' : 'Edit template'}</button>
          {editing && (
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              <textarea aria-label="Message template" rows={4} value={template || DEFAULT_LEAVE_TEMPLATE} onChange={(e) => setTemplate(e.target.value)} />
              <span className="faint xs">Placeholders: {'{name} {day} {date} {times} {classes} {reason}'}. Classes back to back become one time range. Saved for next time.</span>
              {template && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTemplate('')}>Back to the standard template</button>}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The next day after `today` (the usual case: asking for tomorrow's classes). */
export const tomorrow = (today: string) => addDays(today, 1);
