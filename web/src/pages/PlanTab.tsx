import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Dialog, Empty, ErrorNote, Field, Icon, Kind, Loading, Menu, Notice, SessionStatus, useAction, useToast } from '../ui.tsx';
import { ProposalReview, type Proposal } from '../Proposal.tsx';
import { SessionDialog } from '../SessionDialog.tsx';
import { AddSession } from './Timetable.tsx';
import { durationMinutes, formatDate } from '../../../shared/dates.ts';

const ACTIVITY: Record<string, string> = { midterm_review: 'Midterm review', midterm: 'Midterm exam', capstone: 'Capstone work', final_review: 'Final review', final: 'Final exam', buffer: 'Catch-up / buffer', makeup: 'Make-up' };

export function PlanTab({ cls, onChanged }: { cls: any; onChanged: () => void }) {
  const { lang } = useI18n();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data: sessions, error, loading, reload } = useApi<any[]>(`/classes/${cls.id}/sessions`);
  const { data: proposals, reload: reloadProposals } = useApi<Proposal[]>(`/classes/${cls.id}/proposals`);
  const [preview, setPreview] = useState<any | null>(null);
  const [review, setReview] = useState<Proposal | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const { busy, run } = useAction();
  const teachId = Number(params.get('session')) || null;
  const today: string = cls.today;

  const parts = useMemo(() => new Map<number, any>(cls.parts.map((p: any) => [p.id, p])), [cls.parts]);
  const partName = (id: number | null) => (id && parts.get(id) ? `${parts.get(id).code} ${parts.get(id).title ?? parts.get(id).lessonTitle}` : null);
  const refresh = () => { reload(); reloadProposals(); onChanged(); };
  const pending = proposals?.find((p) => p.status === 'pending');
  const hasRecords = sessions?.some((s) => s.record_id);

  const generate = async () => {
    const r = await run(() => api(`/classes/${cls.id}/plan`, { body: { dryRun: true } }));
    if (r) setPreview(r);
  };
  const replan = () => run(() => api(`/classes/${cls.id}/proposals`, { body: { reason: 'Re-planned from the current records and rules' } })).then((r) => { if (!r) return; if (r.none) toast('The plan already matches the teaching records and rules.'); else setReview(r); reloadProposals(); });

  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !sessions) return <Loading rows={10} />;
  const weeks = [...new Set((sessions ?? []).map((s) => s.week))].sort((a, b) => a - b);
  const teach = sessions?.find((s) => s.id === teachId);
  const open = sessions?.find((s) => s.id === openId);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between no-print">
        <div className="row">
          {!sessions?.length && <button className="btn primary" disabled={busy || !cls.meetings.length} onClick={generate}><Icon name="calendar" />Generate term plan</button>}
          {sessions && sessions.length > 0 && <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" />Make-up session</button>}
          <label className="check"><input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} /> Compare with original plan</label>
        </div>
        <Menu label="More" items={[
          { label: 'Review schedule changes…', hidden: !sessions?.length, onSelect: replan },
          { label: 'Regenerate plan…', hidden: !sessions?.length || hasRecords, onSelect: generate },
          { label: 'Export to Excel', onSelect: () => download(`/export/plan/${cls.id}`).catch((e) => toast(e.message, 'bad')) },
          { label: 'Print / PDF', href: `/print/plan/${cls.id}` },
        ]} />
      </div>
      {!cls.meetings.length && <Notice tone="warn">Add meeting times under Setup before generating a plan.</Notice>}
      {pending && <Notice tone="warn"><div className="row between"><span><b>Waiting for review:</b> {pending.reason} — {pending.changes.length} session(s) would change.</span><button className="btn sm primary" onClick={() => setReview(pending)}>Review</button></div></Notice>}

      {!sessions?.length ? (
        <div className="panel"><Empty title="No term plan yet">Generating creates every session from the class start date, meeting times, holidays and the course’s 17-week template. You review it before saving.</Empty></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Wk</th><th>Date</th><th>Time</th><th>Type</th><th>{showOriginal ? 'Original plan → current plan' : 'Planned lesson'}</th><th>Status</th><th>Actually taught</th><th className="no-print" /></tr></thead>
            <tbody>
              {weeks.map((w) => (
                <Fragment key={w}>
                  {(sessions ?? []).filter((s) => s.week === w).map((s, i, arr) => {
                    const taught = s.taught_parts as Array<{ partId: number; coverage: string }>;
                    const isPast = s.date < today && s.status === 'planned';
                    return (
                      <tr key={s.id} className={`${s.status === 'moved' ? 'is-dim' : ''}`} style={i === 0 ? { borderTop: '2px solid var(--rule-strong)' } : undefined}>
                        <td className="mono faint">{i === 0 ? w : ''}</td>
                        <td className="mono" style={{ whiteSpace: 'nowrap' }}>{formatDate(s.date, lang)}{s.original_date !== s.date && <div className="faint xs">was {formatDate(s.original_date, lang)}</div>}</td>
                        <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{s.start_time}–{s.end_time}</td>
                        <td><Kind kind={s.kind} />{s.kind_source === 'manual' && <span className="faint xs" title="Set by hand"> ✎</span>}</td>
                        <td>
                          {showOriginal && s.original_part_id !== s.part_id && <span className="faint">{partName(s.original_part_id) ?? '—'} → </span>}
                          <span className={s.status === 'cancelled' || s.status === 'moved' ? 'strike' : ''}>{s.activity === 'lesson' ? partName(s.part_id) ?? 'Free lesson slot' : ACTIVITY[s.activity] ?? s.activity}</span>
                          {s.checkpoint && <span className="marker small" style={{ marginLeft: 6 }}>{s.checkpoint}</span>}
                          {s.note && <div className="faint xs">{s.note}</div>}
                        </td>
                        <td><SessionStatus status={s.status} />{s.confirmed ? <div className="faint xs">confirmed</div> : null}</td>
                        <td className="small">
                          {taught.length ? taught.map((t) => <div key={t.partId}>{partName(t.partId)}{t.coverage === 'partial' && <span className="pill warn" style={{ marginLeft: 4 }}>partial</span>}</div>) : s.status === 'completed' ? <span className="faint">Taught (no lesson content)</span> : isPast ? <span className="pill warn">not recorded</span> : null}
                          {s.record_notes && <div className="faint xs">{s.record_notes}</div>}
                          {s.follow_up && <div className="xs">Follow-up: {s.follow_up}</div>}
                        </td>
                        <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                          {(s.status === 'planned' || s.status === 'completed') && <button className="btn sm" onClick={() => setParams({ session: String(s.id) })}>{s.status === 'completed' ? 'Edit record' : 'Record'}</button>}{' '}
                          <button className="btn sm ghost" aria-label="More actions" onClick={() => setOpenId(s.id)}><Icon name="more" /></button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && <PlanPreview preview={preview} partName={partName} onClose={() => setPreview(null)} onSave={() => run(() => api(`/classes/${cls.id}/plan`, { body: {} }), 'Term plan saved').then((r) => { if (r) { setPreview(null); refresh(); } })} busy={busy} />}
      {review && <ProposalReview proposal={review} onClose={() => setReview(null)} onDone={() => { setReview(null); refresh(); }} />}
      {teach && <TeachDialog cls={cls} session={teach} onClose={() => setParams({})} onSaved={(p) => { setParams({}); refresh(); if (p) setReview(p); }} />}
      {open && <SessionDialog session={{ ...open, code: cls.code, classId: cls.id, part: partName(open.part_id) }} today={today} onClose={() => setOpenId(null)} onChanged={refresh} />}
      {adding && <AddSession classId={cls.id} defaultDate={today} onClose={() => setAdding(false)} onDone={refresh} />}
    </div>
  );
}

function PlanPreview({ preview, partName, onClose, onSave, busy }: { preview: any; partName: (id: number | null) => string | null; onClose: () => void; onSave: () => void; busy: boolean }) {
  const { lang } = useI18n();
  const list: any[] = preview.preview;
  const taught = list.filter((s) => s.status === 'planned');
  return (
    <Dialog wide title="Review the generated plan" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={onSave}>Save plan ({list.length} sessions)</button></>}>
      <p className="muted">{taught.length} teaching sessions over {Math.max(...list.map((s) => s.week))} weeks. {list.length - taught.length} fall on holidays and are shown as cancelled. Sessions you already confirmed are kept as they are.</p>
      {preview.warnings.map((w: string) => <Notice key={w} tone="warn">{w}</Notice>)}
      <div className="table-wrap panel" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>Wk</th><th>Date</th><th>Time</th><th>Type</th><th>Lesson</th></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.genKey} className={s.status === 'cancelled' ? 'is-dim' : ''}>
              <td className="mono">{s.week}</td><td className="mono">{formatDate(s.date, lang)}</td><td className="mono small">{s.start}–{s.end}</td><td><Kind kind={s.kind} /></td>
              <td className={s.status === 'cancelled' ? 'strike' : ''}>{s.status === 'cancelled' ? s.note : s.activity === 'lesson' ? partName(s.partId) : ACTIVITY[s.activity]}{s.checkpoint && <span className="marker small" style={{ marginLeft: 6 }}>{s.checkpoint}</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Dialog>
  );
}

function TeachDialog({ cls, session, onClose, onSaved }: { cls: any; session: any; onClose: () => void; onSaved: (p: Proposal | null) => void }) {
  const existing: Array<{ partId: number; coverage: string }> = session.taught_parts ?? [];
  const initial: Record<number, 'full' | 'partial'> = {};
  if (existing.length) for (const e of existing) initial[e.partId] = e.coverage as any;
  else if (session.part_id) initial[session.part_id] = 'full';
  const [sel, setSel] = useState<Record<number, 'full' | 'partial'>>(initial);
  const [minutes, setMinutes] = useState<number>(session.minutes ?? durationMinutes(session.start_time, session.end_time));
  const [pace, setPace] = useState(session.pace ?? 'on_plan');
  const [notes, setNotes] = useState(session.record_notes ?? '');
  const [followUp, setFollowUp] = useState(session.follow_up ?? '');
  const { busy, run } = useAction();
  const nextIdx = cls.parts.findIndex((p: any) => p.id === (cls.summary.nextPart?.id ?? session.part_id));
  const shown = cls.parts.slice(Math.max(0, nextIdx - 2), nextIdx + 6);
  const extra = Object.keys(sel).map(Number).filter((id) => !shown.some((p: any) => p.id === id)).map((id) => cls.parts.find((p: any) => p.id === id)).filter(Boolean);
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? cls.parts : [...extra, ...shown];

  const save = () => run(() => api(`/sessions/${session.id}/complete`, { body: { parts: Object.entries(sel).map(([partId, coverage]) => ({ partId: +partId, coverage })), minutes, pace, notes, followUp } }), 'Teaching recorded').then((r) => { if (r) onSaved(r.proposal); });
  const reopen = () => run(() => api(`/sessions/${session.id}/reopen`, { method: 'POST' }), 'Record removed; the session is planned again').then((r) => { if (r) onSaved(null); });

  return (
    <Dialog title={<>Record what was taught · <span className="mono">{cls.code}</span> <D date={session.date} /></>} onClose={onClose} footer={<>
      {session.record_id && <button className="btn danger" disabled={busy} onClick={reopen}>Remove record</button>}
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={save}>Save record</button>
    </>}>
      <div className="row small muted"><Kind kind={session.kind} /> {session.start_time}–{session.end_time} · planned: {cls.parts.find((p: any) => p.id === session.part_id)?.code ?? 'no lesson'}</div>
      <div className="stack" style={{ gap: 4 }}>
        <h3>Lessons covered</h3>
        <p className="faint xs">Tick everything you covered. Mark a part “partial” if it needs to continue next time; it stays as the next lesson.</p>
        <div className="panel">
          <ul className="ledger">
            {list.map((p: any) => (
              <li key={p.id} style={{ alignItems: 'center', padding: '7px 12px' }}>
                <input type="checkbox" id={`p${p.id}`} checked={!!sel[p.id]} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[p.id] = 'full'; else delete n[p.id]; setSel(n); }} />
                <label htmlFor={`p${p.id}`} className="grow small"><b className="mono">{p.code}</b> {p.title ?? p.lessonTitle}{p.id === cls.summary.nextPart?.id && <span className="pill accent" style={{ marginLeft: 6 }}>next</span>}</label>
                {sel[p.id] && <div className="seg"><button className={sel[p.id] === 'full' ? 'on' : ''} onClick={() => setSel({ ...sel, [p.id]: 'full' })}>Full</button><button className={sel[p.id] === 'partial' ? 'on' : ''} onClick={() => setSel({ ...sel, [p.id]: 'partial' })}>Partial</button></div>}
              </li>
            ))}
          </ul>
        </div>
        {!showAll && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>Show the whole curriculum</button>}
      </div>
      <div className="form-grid">
        <Field label="Minutes taught"><input id="t-min" type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(+e.target.value)} /></Field>
        <Field label="Pace">
          <select id="t-pace" value={pace} onChange={(e) => setPace(e.target.value)}><option value="on_plan">As planned</option><option value="early">Finished early / ahead</option><option value="behind">Fell behind</option></select>
        </Field>
      </div>
      <Field label="Notes"><textarea id="t-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened in class" /></Field>
      <Field label="Follow-up" hint="Tasks or materials needed before the next session."><input id="t-follow" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></Field>
    </Dialog>
  );
}
