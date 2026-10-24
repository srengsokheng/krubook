import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { Confirm, D, Empty, ErrorNote, Field, Icon, Kind, Loading, Notice, Pill, TabBar, money, useAction, useTab } from '../ui.tsx';

const TABS = ['sessions', 'ids'] as const;

/** Things only the teacher can decide: what happened in past sessions, and official student IDs. */
export function Review() {
  const [tab, setTab] = useTab(TABS, 'sessions');
  return (
    <div className="page">
      <div className="page-head"><h1>Review</h1></div>
      <TabBar tabs={TABS} value={tab} onChange={setTab} labels={{ sessions: 'Past sessions', ids: 'Student IDs' }} />
      {tab === 'sessions' ? <Sessions /> : <StudentIds />}
    </div>
  );
}

// ---- Past sessions -------------------------------------------------------------------------------

type Choice = '' | 'taught' | 'cancelled' | 'skipped';
const CHOICES: Array<[Choice, string]> = [['', 'Not decided'], ['taught', 'Taught'], ['cancelled', 'Not held (cancelled)'], ['skipped', 'Skipped']];

function Sessions() {
  const { data, error, loading, reload } = useApi<any[]>('/reconcile/sessions');
  const [choice, setChoice] = useState<Record<number, Choice>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<any | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();
  const byClass = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const s of data ?? []) m.set(s.code, [...(m.get(s.code) ?? []), s]);
    return [...m.entries()];
  }, [data]);
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  if (!data?.length) return <div className="panel"><Empty title="Every past session has a decision">Sessions appear here when their date passes without a teaching record.</Empty></div>;

  const decided = Object.entries(choice).filter(([, c]) => c).map(([id, c]) => ({ sessionId: +id, action: c, note: notes[+id] || undefined }));
  const set = (ids: number[], c: Choice) => { setChoice((x) => { const n = { ...x }; for (const id of ids) n[id] = c; return n; }); setPreview(null); };
  const doPreview = () => run(() => api('/reconcile/sessions?dryRun=1', { body: { decisions: decided } })).then((r) => r && setPreview(r));
  const apply = () => run(() => api('/reconcile/sessions', { body: { decisions: decided } }), `${decided.length} session(s) updated`).then((r) => { if (r) { setChoice({}); setNotes({}); setPreview(null); reload(); } });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Notice tone="info">{data.length} past session{data.length > 1 ? 's have' : ' has'} no teaching record, so {data.length > 1 ? 'they count' : 'it counts'} as neither taught nor paid. Decide each one; anything left undecided stays as it is.</Notice>
      {byClass.map(([code, rows]) => (
        <section key={code} className="panel">
          <div className="panel-head">
            <h2 className="row" style={{ gap: 8 }}><span className="dot" style={{ background: rows[0].color }} /><Link className="mono" to={`/classes/${rows[0].classId}/plan`}>{code}</Link> <span className="faint small">{rows.length}</span></h2>
            <div className="row">
              <span className="faint xs">Mark all:</span>
              {CHOICES.slice(1).map(([c, label]) => <button key={c} className="btn sm" onClick={() => set(rows.map((r) => r.sessionId), c)}>{label.split(' ')[0]}</button>)}
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Type</th><th>Planned</th><th className="num">Pay if taught</th><th>Decision</th><th>Note</th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.sessionId}>
                  <td className="mono small" style={{ whiteSpace: 'nowrap' }}><D date={s.date} /> {s.start}–{s.end}</td>
                  <td><Kind kind={s.kind} /></td>
                  <td className="small">{s.plannedPart ? `${s.plannedPart.code} ${s.plannedPart.title}` : s.note ?? 'Review / buffer'}</td>
                  <td className="num mono small">{s.estimatedPay == null ? <Pill tone="warn">no rate</Pill> : money(s.estimatedPay)}</td>
                  <td style={{ minWidth: 170 }}>
                    <select aria-label={`Decision for ${code} ${s.date}`} value={choice[s.sessionId] ?? ''} onChange={(e) => set([s.sessionId], e.target.value as Choice)}>
                      {CHOICES.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 160 }}><input aria-label="Note" value={notes[s.sessionId] ?? ''} onChange={(e) => setNotes({ ...notes, [s.sessionId]: e.target.value })} placeholder="optional" /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ))}

      <div className="row between panel panel-body" style={{ position: 'sticky', bottom: 0, zIndex: 5 }}>
        <span className="small"><b>{decided.length}</b> of {data.length} decided</span>
        <div className="row">
          <button className="btn" disabled={busy || !decided.length} onClick={doPreview}>Preview impact</button>
          <button className="btn primary" disabled={busy || !preview} onClick={() => setConfirming(true)} title={preview ? '' : 'Preview first'}>Apply {decided.length || ''}</button>
        </div>
      </div>

      {preview && (
        <section className="panel">
          <div className="panel-head"><h2>Impact of these decisions</h2><button className="btn sm ghost" onClick={() => setPreview(null)}>Close</button></div>
          <div className="grid two panel-body">
            <div className="stack" style={{ gap: 6 }}>
              <h3>Progress</h3>
              <table className="table"><thead><tr><th>Class</th><th>Parts taught</th><th>Status</th><th>Unrecorded</th></tr></thead>
                <tbody>{preview.before.progress.map((b: any, i: number) => { const a = preview.after.progress[i]; return (
                  <tr key={b.classId}><td className="mono">{b.code}</td><td className="mono">{b.actual} → <b>{a.actual}</b></td><td className="small">{b.status.replace('_', ' ')} → <b>{a.status.replace('_', ' ')}</b></td><td className="mono">{b.unrecorded} → <b>{a.unrecorded}</b></td></tr>); })}</tbody>
              </table>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <h3>Pay (estimates)</h3>
              <table className="table"><thead><tr><th>Month</th><th>Sessions</th><th>Hours</th><th className="num">Month total</th></tr></thead>
                <tbody>{preview.after.pay.map((a: any) => { const b = preview.before.pay.find((x: any) => x.month === a.month) ?? { taughtSessions: 0, hours: 0, total: 0 }; return (
                  <tr key={a.month}><td className="mono">{a.month}</td><td className="mono">{b.taughtSessions} → <b>{a.taughtSessions}</b></td><td className="mono">{b.hours} → <b>{a.hours}</b></td><td className="num mono">{money(b.total)} → <b>{money(a.total)}</b></td></tr>); })}</tbody>
              </table>
            </div>
          </div>
        </section>
      )}
      {confirming && <Confirm title={`Apply ${decided.length} decision(s)?`} body="Taught sessions get a teaching record; cancelled and skipped sessions stop counting. Each change is logged and can be corrected from the class's term plan." confirmLabel="Apply" onConfirm={apply} onClose={() => setConfirming(false)} />}
    </div>
  );
}

// ---- Official student IDs ------------------------------------------------------------------------

const ID_FIELDS = [['officialId', 'Official ID', /id|code|អត្តលេខ/i], ['nameKm', 'Khmer name', /khmer|ខ្មែរ|ឈ្មោះ/i], ['nameLatin', 'Latin name', /latin|english|name/i], ['classCode', 'Class (optional)', /class|ថ្នាក់|group|section/i]] as const;
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'accent' | undefined> = { match: 'ok', unchanged: undefined, ambiguous: 'warn', none: 'warn', conflict: 'bad', invalid: 'bad' };

function StudentIds() {
  const [sheet, setSheet] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [result, setResult] = useState<any | null>(null);
  const [pick, setPick] = useState<Record<number, number | ''>>({});
  const [filter, setFilter] = useState('all');
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();

  const onFile = (f: File) => run(async () => {
    const parsed = await api(`/import/parse?filename=${encodeURIComponent(f.name)}`, { raw: await f.arrayBuffer(), headers: { 'content-type': 'application/octet-stream' } });
    setSheet(parsed); setResult(null);
    const m: Record<string, number> = {}; const used = new Set<number>();
    for (const [k, , re] of ID_FIELDS) { const i = parsed.headers.findIndex((h: string, idx: number) => !used.has(idx) && re.test(h)); if (i >= 0) { m[k] = i; used.add(i); } }
    setMap(m);
  });
  const match = () => run(async () => {
    const rows = sheet!.rows.map((r, i) => { const o: any = { row: i + 2 }; for (const [k] of ID_FIELDS) if (map[k] !== undefined) o[k] = (r[map[k]] ?? '').trim(); return o; });
    const r = await api('/students/id-match', { body: { rows } });
    setResult(r);
    setPick(Object.fromEntries(r.matches.filter((m: any) => m.status === 'match').map((m: any) => [m.row, m.suggested])));
  });
  const chosen = result ? result.matches.filter((m: any) => pick[m.row]).map((m: any) => ({ studentId: pick[m.row] as number, newCode: m.officialId })) : [];
  const apply = () => run(() => api('/students/id-apply', { body: { assignments: chosen } }), 'Student IDs updated').then((r) => { if (r) { setResult(null); setSheet(null); setPick({}); } });
  const exportUnresolved = () => {
    const rows = result.matches.filter((m: any) => !pick[m.row] && m.status !== 'unchanged');
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['row,official_id,khmer_name,latin_name,class,status,reason,candidates', ...rows.map((m: any) => [m.row, m.officialId, m.input.nameKm, m.input.nameLatin, m.input.classCode, m.status, m.reason, m.candidates.map((c: any) => `${c.code} ${c.nameLatin ?? ''}`).join(' | ')].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'unresolved-student-ids.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  if (!sheet) return (
    <section className="panel">
      <div className="panel-body stack">
        <p>Upload an authorised export (Excel or CSV) with official student IDs and names. Nothing changes until you confirm each match.</p>
        <input type="file" accept=".xlsx,.csv" aria-label="Student ID file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
    </section>
  );
  if (!result) return (
    <section className="panel">
      <div className="panel-head"><h2>Match the columns</h2><button className="btn sm ghost" onClick={() => setSheet(null)}>Choose another file</button></div>
      <div className="panel-body stack">
        <div className="form-grid">
          {ID_FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <select value={map[k] ?? -1} onChange={(e) => { const v = +e.target.value; const n = { ...map }; if (v < 0) delete n[k]; else n[k] = v; setMap(n); }}>
                <option value={-1}>Not in the file</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
            </Field>
          ))}
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || map.officialId === undefined || (map.nameKm === undefined && map.nameLatin === undefined)} onClick={match}>Find matches for {sheet.rows.length} rows</button>
      </div>
    </section>
  );

  const shown = result.matches.filter((m: any) => filter === 'all' || m.status === filter);
  return (
    <div className="stack">
      <div className="row between">
        <div className="seg">
          {['all', 'match', 'ambiguous', 'none', 'conflict', 'invalid', 'unchanged'].map((s) => <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>{s} {s === 'all' ? result.matches.length : result.summary[s] ?? 0}</button>)}
        </div>
        <div className="row">
          <button className="btn" onClick={exportUnresolved}><Icon name="download" />Unresolved (CSV)</button>
          <button className="btn primary" disabled={busy || !chosen.length} onClick={() => setConfirming(true)}>Apply {chosen.length} ID{chosen.length === 1 ? '' : 's'}</button>
        </div>
      </div>
      <div className="panel table-wrap">
        <table className="table">
          <thead><tr><th>Row</th><th>Official ID</th><th>In the file</th><th>Status</th><th>Assign to</th></tr></thead>
          <tbody>{shown.map((m: any) => (
            <tr key={m.row}>
              <td className="mono faint">{m.row}</td>
              <td className="mono">{m.officialId || '—'}</td>
              <td className="small">{m.input.nameKm} <span className="faint">{m.input.nameLatin}</span>{m.input.classCode && <span className="faint mono"> · {m.input.classCode}</span>}</td>
              <td><Pill tone={STATUS_TONE[m.status]}>{m.status}</Pill><div className="faint xs" style={{ maxWidth: 260 }}>{m.reason}</div></td>
              <td style={{ minWidth: 240 }}>
                {['match', 'ambiguous'].includes(m.status) ? (
                  <select aria-label={`Student for row ${m.row}`} value={pick[m.row] ?? ''} onChange={(e) => setPick({ ...pick, [m.row]: e.target.value ? +e.target.value : '' })}>
                    <option value="">Leave unchanged</option>
                    {m.candidates.map((c: any) => <option key={c.studentId} value={c.studentId}>{c.code} · {c.nameLatin ?? c.nameKm} ({c.classes || 'no class'})</option>)}
                  </select>
                ) : <span className="faint small">{m.status === 'unchanged' ? 'Already set' : 'Not assignable'}</span>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {confirming && <Confirm title={`Change ${chosen.length} student ID(s)?`} body="Grades, attendance and enrollments stay attached to the same students. Each old and new ID is written to the activity log." confirmLabel="Change IDs" onConfirm={apply} onClose={() => setConfirming(false)} />}
    </div>
  );
}
