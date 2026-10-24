import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, isOfflineCopy, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Dialog, ErrorNote, Field, Icon, Loading, Menu, Notice, Pill, fmt, useAction, useToast } from '../ui.tsx';
import { enqueue, onApplied, pendingOps } from '../offline.ts';
import { useSync } from '../SyncStatus.tsx';
import { checkConfig, classStats, computeStudent, parseScoreInput, validateScore, type GradeConfig } from '../../../shared/grades.ts';

type Cell = { value: number | null; version: number | null; pending?: boolean; error?: string };

export function GradebookTab({ cls }: { cls: any }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/classes/${cls.id}/gradebook`);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'code', dir: 1 });
  const [filter, setFilter] = useState<'all' | 'missing' | 'risk'>('all');
  const [editing, setEditing] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const sync = useSync();
  const tableRef = useRef<HTMLTableElement>(null);

  // Build the cell map from the server, then lay any queued (unsynced) edits on top.
  useEffect(() => {
    if (!data) return;
    const m: Record<string, Cell> = {};
    for (const r of data.rows) for (const c of data.config.components) {
      const s = r.scores[c.id];
      m[`${r.enrollmentId}:${c.id}`] = { value: s?.value ?? null, version: s?.version ?? null };
    }
    pendingOps().then((ops) => {
      for (const op of ops) if (op.type === 'score' && m[`${op.enrollmentId}:${op.componentId}`]) m[`${op.enrollmentId}:${op.componentId}`] = { ...m[`${op.enrollmentId}:${op.componentId}`], value: op.value, pending: true };
      setCells({ ...m });
    });
  }, [data]);

  // After a sync, re-read the gradebook so the copy kept for offline use matches the server.
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => onApplied((list) => {
    setCells((prev) => {
      const n = { ...prev };
      for (const a of list) if (a.op.type === 'score') { const k = `${a.op.enrollmentId}:${a.op.componentId}`; if (n[k]) n[k] = { ...n[k], version: a.version, pending: false }; }
      return n;
    });
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(reload, 2500);
  }), [reload]);
  // Failed edits are reported by the sync banner; re-read the server copy when one arrives.
  useEffect(() => { if (sync?.failures.length) reload(); }, [sync?.failures.length, reload]);

  const config: GradeConfig | null = data ? data.config : null;
  const comps = config?.components ?? [];
  const valid = data?.check.valid;

  // Totals are recalculated in the browser with the same shared rules the server uses.
  const rows = useMemo(() => {
    if (!data || !config) return [];
    return data.rows.map((r: any) => {
      const scores: Record<number, number | null> = {};
      for (const c of comps) scores[c.id] = cells[`${r.enrollmentId}:${c.id}`]?.value ?? null;
      const res = computeStudent(config, scores, r.attendance?.score ?? null);
      return { ...r, ...res, result: valid ? res.result : 'incomplete', label: valid ? res.label : '' };
    });
  }, [data, cells, config, comps, valid]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((r: any) => !q || r.code.toLowerCase().includes(q) || (r.nameLatin ?? '').toLowerCase().includes(q) || (r.nameKm ?? '').includes(q));
    if (filter === 'missing') list = list.filter((r: any) => r.missing.length);
    if (filter === 'risk') list = list.filter((r: any) => r.atRisk);
    const val = (r: any) => (sort.key === 'code' ? r.code : sort.key === 'km' ? r.nameKm ?? '' : sort.key === 'latin' ? r.nameLatin ?? '' : sort.key === 'total' ? r.total : r.values[+sort.key] ?? -1);
    const collator = new Intl.Collator(sort.key === 'km' ? 'km' : 'en', { numeric: true });
    return [...list].sort((a, b) => {
      const ea = a.enrollmentStatus === 'active' || a.enrollmentStatus === 'completed' ? 0 : 1, eb = b.enrollmentStatus === 'active' || b.enrollmentStatus === 'completed' ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const x = val(a), y = val(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y))) * sort.dir;
    });
  }, [rows, query, filter, sort]);

  const stats = useMemo(() => classStats(rows.filter((r: any) => r.enrollmentStatus === 'active' || r.enrollmentStatus === 'completed')), [rows]);
  const editable = data?.config.status !== 'finalized';

  const commit = useCallback((entries: Array<{ enrollmentId: number; componentId: number; raw: string }>) => {
    if (!data) return;
    const ops: any[] = [];
    const next: Record<string, Cell> = {};
    for (const e of entries) {
      const k = `${e.enrollmentId}:${e.componentId}`;
      const comp = comps.find((c) => c.id === e.componentId)!;
      const parsed = parseScoreInput(e.raw);
      const cur = cells[k];
      if (!parsed.ok) { next[k] = { ...cur, error: parsed.error }; continue; }
      if (parsed.value !== null) {
        const err = validateScore(parsed.value, comp.max);
        if (err) { next[k] = { ...cur, error: err }; continue; }
      }
      if (parsed.value === cur?.value && !cur?.error) continue;
      next[k] = { ...cur, value: parsed.value, pending: true, error: undefined };
      const row = data.rows.find((r: any) => r.enrollmentId === e.enrollmentId);
      ops.push({ type: 'score', enrollmentId: e.enrollmentId, componentId: e.componentId, value: parsed.value, baseVersion: cur?.version ?? null, label: `${cls.code} ${row?.code} ${comp.name}` });
    }
    setCells((p) => ({ ...p, ...next }));
    // Invalid text stays in the cell (underlined) so the teacher can see and correct it.
    setDrafts((d) => { const n = { ...d }; for (const e of entries) { const k = `${e.enrollmentId}:${e.componentId}`; if (next[k]?.error) n[k] = e.raw; else delete n[k]; } return n; });
    if (ops.length) void enqueue(ops);
  }, [cells, comps, data, cls.code]);

  const manualComps = comps; // attendance column accepts a manual override
  const focusCell = (row: number, col: number) => {
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-r="${row}"][data-c="${col}"]`);
    if (el) { el.focus(); el.select(); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const maxR = visible.length - 1, maxC = manualComps.length - 1;
    const move = (r: number, c: number) => { e.preventDefault(); focusCell(Math.max(0, Math.min(maxR, r)), Math.max(0, Math.min(maxC, c))); };
    if (e.key === 'Enter' || e.key === 'ArrowDown') move(row + 1, col);
    else if (e.key === 'ArrowUp') move(row - 1, col);
    else if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) col === 0 ? move(row - 1, maxC) : move(row, col - 1); else col === maxC ? move(row + 1, 0) : move(row, col + 1); }
    else if (e.key === 'ArrowRight' && (e.currentTarget.selectionStart === e.currentTarget.value.length)) move(row, col + 1);
    else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0) move(row, col - 1);
    else if (e.key === 'Escape') { const k = e.currentTarget.dataset.k!; setDrafts((d) => { const n = { ...d }; delete n[k]; return n; }); }
  };
  // Paste a block from Excel: rows by newline, columns by tab, starting at the focused cell.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, row: number, col: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
    const entries: Array<{ enrollmentId: number; componentId: number; raw: string }> = [];
    lines.forEach((line, i) => line.split('\t').forEach((v, j) => {
      const r = visible[row + i], c = manualComps[col + j];
      if (r && c) entries.push({ enrollmentId: r.enrollmentId, componentId: c.id, raw: v });
    }));
    commit(entries);
    const bad = entries.length - lines.reduce((s, l) => s + l.split('\t').length, 0);
    toast(`Pasted ${entries.length} value(s)${bad < 0 ? `; ${-bad} fell outside the table and were ignored` : ''}. Invalid values are underlined in red.`);
  };

  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={10} />;
  if (!data || !config) return null;
  const th = (key: string, label: React.ReactNode, cls2 = '') => (
    <th className={cls2} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="btn ghost sm" style={{ height: 'auto', padding: 0, font: 'inherit', color: 'inherit' }} onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}>{label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
    </th>
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      {isOfflineCopy(data) && <Notice tone="warn">You are offline. This is the gradebook as it was last loaded; your edits are saved on this device and will sync when you reconnect.</Notice>}
      {!valid && (
        <Notice tone="bad">
          <div className="row between">
            <span><b>The grading setup is not valid, so results are not shown.</b> {data.check.errors.join(' ')}</span>
            <button className="btn sm" onClick={() => setEditing(true)}>Fix grading setup</button>
          </div>
        </Notice>
      )}
      {valid && data.config.status === 'draft' && <Notice tone="warn"><div className="row between"><span>The grading setup adds up to {data.check.total} but is still a draft.</span><button className="btn sm primary" onClick={() => api(`/classes/${cls.id}/grade-config/status`, { body: { status: 'active' } }).then(reload).catch((e) => toast(e.message, 'bad'))}>Activate</button></div></Notice>}

      <div className="figures">
        <div className="figure"><span className="eyebrow">{t('Average')}</span><span className="value">{fmt(stats.average, 1)}<small> / {config.targetTotal}</small></span><span className="faint xs">{stats.complete} of {stats.students} complete</span></div>
        <div className="figure"><span className="eyebrow">{t('Pass rate')}</span><span className="value">{stats.passRate == null ? '—' : `${fmt(stats.passRate, 0)}%`}</span><span className="faint xs">pass mark {config.passMark}</span></div>
        <div className="figure"><span className="eyebrow">At risk</span><span className="value">{stats.atRisk}</span><span className="faint xs">range {fmt(stats.highest, 1)}–{fmt(stats.lowest, 1)}</span></div>
        <div className="figure"><span className="eyebrow">{t('Missing')} scores</span><span className="value">{stats.missingCells}</span></div>
      </div>

      <div className="row between no-print">
        <div className="row">
          <div className="search"><Icon name="search" /><input aria-label="Search students" placeholder="Search ID or name" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="seg">
            {(['all', 'missing', 'risk'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'missing' ? 'Missing scores' : 'At risk'}</button>)}
          </div>
        </div>
        <div className="row">
          <Pill tone={data.config.status === 'active' ? 'ok' : data.config.status === 'finalized' ? 'ink' : 'warn'}>{data.config.status}</Pill>
          <Menu label="More" items={[
            { label: 'Grading setup…', onSelect: () => setEditing(true) },
            { label: 'Use calculated attendance…', hidden: !comps.some((c) => c.kind === 'attendance'), onSelect: () => setMigrating(true) },
            { label: 'Export to Excel', onSelect: () => download(`/export/gradebook/${cls.id}`).catch((e) => toast(e.message, 'bad')) },
            { label: 'Print / PDF', href: `/print/gradebook/${cls.id}` },
            { label: 'Finalize gradebook', hidden: !(valid && data.config.status === 'active'), onSelect: () => api(`/classes/${cls.id}/grade-config/status`, { body: { status: 'finalized' } }).then(reload).catch((e) => toast(e.message, 'bad')) },
            { label: 'Reopen gradebook', hidden: data.config.status !== 'finalized', onSelect: () => api(`/classes/${cls.id}/grade-config/status`, { body: { status: 'active' } }).then(reload).catch((e) => toast(e.message, 'bad')) },
          ]} />
        </div>
      </div>
      <p className="faint xs no-print">Enter or Tab to move · paste blocks from Excel · empty means not entered, 0 is a score.</p>

      <div className="sheet-wrap">
        <table className="sheet" ref={tableRef}>
          <thead>
            <tr>
              {th('code', t('Student ID'), 'sticky-1')}
              {th('km', <>{t('Khmer name')} · {t('Latin name')}</>, 'sticky-2')}
              {comps.map((c) => <th key={c.id}><button className="btn ghost sm" style={{ height: 'auto', padding: 0, font: 'inherit', color: 'inherit', flexDirection: 'column' }} onClick={() => setSort({ key: String(c.id), dir: sort.key === String(c.id) ? (-sort.dir as 1 | -1) : -1 })}>{c.name}<span className="max">/{c.max}{c.kind === 'attendance' ? ' auto' : ''}</span></button></th>)}
              {th('total', <>{t('Total')}<span className="max">/{config.targetTotal}</span></>)}
              <th>{t('Result')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r: any, ri: number) => {
              const dim = r.enrollmentStatus !== 'active' && r.enrollmentStatus !== 'completed';
              return (
                <tr key={r.enrollmentId} className={`${dim ? 'dim' : ''} ${focusRow === ri ? 'focus-row' : ''}`}>
                  <td className="id sticky-1">{r.code}</td>
                  <td className="name sticky-2" title={`${r.nameKm ?? ''} ${r.nameLatin ?? ''}`}>{r.nameKm ?? r.nameLatin}{r.nameKm && <span className="lat">{r.nameLatin}</span>}{dim && <span className="pill" style={{ marginLeft: 6 }}>{r.enrollmentStatus}</span>}</td>
                  {comps.map((c, ci) => {
                    const k = `${r.enrollmentId}:${c.id}`;
                    const cell = cells[k];
                    const isAtt = c.kind === 'attendance';
                    const shownValue = drafts[k] ?? (cell?.value ?? (isAtt && r.attendance?.score != null ? '' : '')).toString();
                    const missing = cell?.value == null && !(isAtt && r.attendance?.score != null);
                    return (
                      <td key={c.id} className={`cell ${missing ? 'missing' : ''} ${cell?.error ? 'invalid' : ''} ${cell?.pending ? 'pending' : ''}`} title={cell?.error ?? (isAtt ? `Calculated from attendance: ${r.attendance?.score ?? 'no sessions yet'}${cell?.value != null ? ' (overridden)' : ''}` : undefined)}>
                        <input
                          data-r={ri} data-c={ci} data-k={k}
                          inputMode="decimal"
                          aria-label={`${c.name} for ${r.code}`}
                          disabled={!editable}
                          value={shownValue}
                          placeholder={isAtt && r.attendance?.score != null ? String(r.attendance.score) : ''}
                          onFocus={(e) => { setFocusRow(ri); e.currentTarget.select(); }}
                          onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))}
                          onBlur={() => { if (drafts[k] !== undefined) commit([{ enrollmentId: r.enrollmentId, componentId: c.id, raw: drafts[k] }]); }}
                          onKeyDown={(e) => { if (['Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(e.key) && drafts[k] !== undefined) commit([{ enrollmentId: r.enrollmentId, componentId: c.id, raw: drafts[k] }]); onKey(e, ri, ci); }}
                          onPaste={(e) => onPaste(e, ri, ci)}
                        />
                      </td>
                    );
                  })}
                  <td className="total" title={r.missing.length ? `${r.missing.length} score(s) not entered yet` : undefined}>{fmt(r.total, 2)}{r.missing.length > 0 && <span className="faint" style={{ fontWeight: 400 }}> ·{r.missing.length}</span>}</td>
                  <td className="res">{r.label ? <Pill tone={r.result === 'pass' ? 'ok' : 'bad'}>{r.label}</Pill> : r.atRisk ? <Pill tone="warn" title={r.riskReason ?? ''}>at risk</Pill> : <span className="faint xs">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {migrating && <AttendanceMigration cls={cls} onClose={() => setMigrating(false)} onDone={() => { setMigrating(false); reload(); }} />}
      {editing && <ConfigEditor cls={cls} data={data} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

function ConfigEditor({ cls, data, onClose, onSaved }: { cls: any; data: any; onClose: () => void; onSaved: () => void }) {
  const c = data.config;
  const [f, setF] = useState({ targetTotal: c.targetTotal, passMark: c.passMark, labelPass: c.labelPass, labelFail: c.labelFail, attendanceRule: c.attendanceRule });
  const [comps, setComps] = useState<any[]>(c.components.map((x: any) => ({ ...x })));
  const { busy, run } = useAction();
  const check = checkConfig({ targetTotal: f.targetTotal, passMark: f.passMark, components: comps.map((x, i) => ({ ...x, id: x.id ?? -i, key: x.key ?? x.name, max: Number(x.max) })) });
  const set = (i: number, patch: any) => setComps(comps.map((x, j) => (i === j ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) => { const n = [...comps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setComps(n); };
  const save = (activate: boolean) => run(async () => {
    await api(`/classes/${cls.id}/grade-config`, { method: 'PUT', body: { ...f, components: comps.map((x) => ({ ...x, max: Number(x.max) })) } });
    if (activate) await api(`/classes/${cls.id}/grade-config/status`, { body: { status: 'active' } });
  }, activate ? 'Grading setup saved and active' : 'Saved as draft').then(() => onSaved());
  return (
    <Dialog wide title={`Grading setup · ${cls.code}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn" disabled={busy} onClick={() => save(false)}>Save as draft</button>
      <button className="btn primary" disabled={busy || !check.valid} onClick={() => save(true)} title={check.valid ? '' : 'Fix the problems first'}>Save and activate</button>
    </>}>
      <div className={`notice ${check.valid ? 'ok' : 'bad'}`}>
        <Icon name={check.valid ? 'check' : 'alert'} />
        <div>
          <b className="mono">Maximums total {check.total} / {f.targetTotal}</b>
          {check.errors.map((e) => <div key={e} className="small">{e}</div>)}
          {check.valid && <div className="small">Valid. Existing scores are never rescaled when you change maximums.</div>}
        </div>
      </div>
      <div className="table-wrap panel">
        <table className="table">
          <thead><tr><th>Component</th><th className="num">Maximum</th><th>Source</th><th /></tr></thead>
          <tbody>
            {comps.map((x, i) => (
              <tr key={x.id ?? `new${i}`}>
                <td><input aria-label="Component name" value={x.name} onChange={(e) => set(i, { name: e.target.value })} /></td>
                <td style={{ width: 120 }}><input aria-label="Maximum" type="number" min={0} step="0.5" value={x.max} onChange={(e) => set(i, { max: e.target.value })} style={{ textAlign: 'right' }} className="mono" /></td>
                <td style={{ width: 200 }}>
                  <select aria-label="Source" value={x.kind} onChange={(e) => set(i, { kind: e.target.value })}><option value="manual">Entered by hand</option><option value="attendance">Calculated from attendance</option></select>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                  <button className="btn sm ghost" aria-label="Move down" disabled={i === comps.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
                  <button className="btn sm ghost" aria-label="Remove" onClick={() => setComps(comps.filter((_, j) => j !== i))}><Icon name="trash" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setComps([...comps, { name: 'New component', max: 5, kind: 'manual' }])}><Icon name="plus" />Add component</button>
      <div className="form-grid">
        <Field label="Target total"><input id="g-target" type="number" value={f.targetTotal} onChange={(e) => setF({ ...f, targetTotal: +e.target.value })} /></Field>
        <Field label="Pass mark"><input id="g-pass" type="number" value={f.passMark} onChange={(e) => setF({ ...f, passMark: +e.target.value })} /></Field>
        <Field label="Pass label"><input id="g-lp" value={f.labelPass} onChange={(e) => setF({ ...f, labelPass: e.target.value })} /></Field>
        <Field label="Fail label"><input id="g-lf" value={f.labelFail} onChange={(e) => setF({ ...f, labelFail: e.target.value })} /></Field>
        <Field label="Late arrival earns" hint="Share of a present mark, 0 to 1."><input id="g-late" type="number" min={0} max={1} step="0.25" value={f.attendanceRule.lateCredit} onChange={(e) => setF({ ...f, attendanceRule: { ...f.attendanceRule, lateCredit: +e.target.value } })} /></Field>
        <Field label="Excused absences">
          <select id="g-exc" value={f.attendanceRule.excused} onChange={(e) => setF({ ...f, attendanceRule: { ...f.attendanceRule, excused: e.target.value } })}>
            <option value="exclude">Not counted</option><option value="present">Count as present</option><option value="absent">Count as absent</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

/** Preview and switch imported attendance + activity points to the calculated attendance score. */
function AttendanceMigration({ cls, onClose, onDone }: { cls: any; onClose: () => void; onDone: () => void }) {
  const { data, error } = useApi<any>(`/classes/${cls.id}/attendance-migration`);
  const [sel, setSel] = useState<Record<number, boolean> | null>(null);
  const { busy, run } = useAction();
  const rows = (data?.rows ?? []).filter((r: any) => r.manual != null);
  const chosen = sel ?? Object.fromEntries(rows.map((r: any) => [r.enrollmentId, r.change === 'replaced']));
  const ids = Object.entries(chosen).filter(([, v]) => v).map(([k]) => +k);
  return (
    <Dialog wide title="Use calculated attendance" onClose={onClose} footer={<>
      {data?.archived > 0 && <button className="btn" disabled={busy} onClick={() => run(() => api(`/classes/${cls.id}/attendance-migration/restore`, { body: {} }), 'Manual values restored').then((r) => r && onDone())}>Restore {data.archived} manual value(s)</button>}
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !ids.length} onClick={() => run(() => api(`/classes/${cls.id}/attendance-migration`, { body: { enrollmentIds: ids, confirm: true } }), `Calculated attendance now used for ${ids.length} student(s)`).then((r) => r && onDone())}>Switch {ids.length} student{ids.length === 1 ? '' : 's'}</button>
    </>}>
      {error && <ErrorNote error={error} />}
      {!data ? <Loading /> : !rows.length ? <Notice tone="ok">No manual {data.component.name} values. Every student already uses the calculated score.</Notice> : (
        <>
          <p className="muted small">{rows.length} student(s) have a manual {data.component.name} value (/{data.component.max}), for example imported from Excel. Switching removes the manual value and uses the score calculated from {data.sessionsWithRollCall} roll call(s). Manual values are kept and can be restored.</p>
          {data.summary.becomesMissing > 0 && <Notice tone="warn">{data.summary.becomesMissing} student(s) have no roll calls yet; their score would become empty. They are not selected.</Notice>}
          {data.summary.resultChanges > 0 && <Notice tone="warn">{data.summary.resultChanges} result(s) would change between pass and fail.</Notice>}
          <div className="table-wrap panel" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th><input type="checkbox" aria-label="Select all" checked={ids.length === rows.length} onChange={(e) => setSel(Object.fromEntries(rows.map((r: any) => [r.enrollmentId, e.target.checked])))} /></th><th>Student</th><th className="num">Manual</th><th className="num">Calculated</th><th className="num">Total</th><th>Result</th></tr></thead>
              <tbody>{rows.map((r: any) => (
                <tr key={r.enrollmentId}>
                  <td><input type="checkbox" aria-label={`Switch ${r.code}`} checked={!!chosen[r.enrollmentId]} onChange={(e) => setSel({ ...chosen, [r.enrollmentId]: e.target.checked })} /></td>
                  <td className="small"><span className="mono faint">{r.code}</span> {r.nameKm ?? r.nameLatin}</td>
                  <td className="num mono">{fmt(r.manual)}</td>
                  <td className="num mono">{r.calculated == null ? <span className="faint">none yet</span> : fmt(r.calculated)}</td>
                  <td className="num mono">{fmt(r.totalBefore)} → <b>{fmt(r.totalAfter)}</b></td>
                  <td className="small">{r.resultBefore === r.resultAfter ? <span className="faint">{r.resultAfter}</span> : <b>{r.resultBefore} → {r.resultAfter}</b>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}
