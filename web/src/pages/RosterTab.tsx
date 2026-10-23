import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { D, Dialog, Empty, ErrorNote, Field, Icon, Loading, Notice, Pill, useAction, useToast } from '../ui.tsx';

export function RosterTab({ cls, onChanged }: { cls: any; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>(`/classes/${cls.id}/roster`);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<any | null>(null);
  const [q, setQ] = useState('');
  const [sortKm, setSortKm] = useState(false);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = (data ?? []).filter((r) => !s || r.student_code.toLowerCase().includes(s) || (r.name_latin ?? '').toLowerCase().includes(s) || (r.name_km ?? '').includes(s));
    if (sortKm) { const c = new Intl.Collator('km'); l.sort((a, b) => c.compare(a.name_km ?? '', b.name_km ?? '')); }
    return l;
  }, [data, q, sortKm]);
  const refresh = () => { reload(); onChanged(); };
  if (error) return <ErrorNote error={error} retry={reload} />;
  const active = (data ?? []).filter((r) => r.status === 'active').length;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between no-print">
        <div className="row">
          <div className="search"><Icon name="search" /><input aria-label="Search" placeholder={`${t('Search')} ID, Khmer or Latin name`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={sortKm} onChange={(e) => setSortKm(e.target.checked)} /> Sort by Khmer name</label>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setImporting(true)}><Icon name="upload" />{t('Import students')}</button>
          <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" />{t('Add student')}</button>
          <button className="btn" onClick={() => download(`/export/roster/${cls.id}`).catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Excel</button>
        </div>
      </div>
      <p className="muted small">{active} active · {(data?.length ?? 0) - active} left the class (kept with their grades and attendance)</p>
      {loading && !data ? <Loading rows={8} /> : !data?.length ? (
        <div className="panel"><Empty title="No students in this class" action={<button className="btn primary" onClick={() => setImporting(true)}>Import from Excel or CSV</button>} /></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>{t('Student ID')}</th><th>{t('Khmer name')}</th><th>{t('Latin name')}</th><th>Gender</th><th>Enrolled</th><th>{t('Status')}</th><th /></tr></thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.enrollment_id} className={r.status !== 'active' ? 'is-dim' : ''}>
                  <td className="mono faint">{i + 1}</td>
                  <td className="mono"><Link to={`/students/${r.id}`}>{r.student_code}</Link></td>
                  <td>{r.name_km}</td>
                  <td>{r.name_latin}</td>
                  <td>{r.gender}</td>
                  <td className="mono small"><D date={r.enrolled_on} /></td>
                  <td><Pill tone={r.status === 'active' ? 'ok' : r.status === 'transferred' ? 'accent' : 'warn'}>{r.status}</Pill>{r.ended_on && <div className="faint xs">since <D date={r.ended_on} /></div>}</td>
                  <td>{r.status === 'active' ? <button className="btn sm" onClick={() => setActing(r)}>Transfer / drop</button> : (r.status === 'dropped' || r.status === 'withdrawn') && <button className="btn sm ghost" onClick={() => api(`/enrollments/${r.enrollment_id}/status`, { body: { status: 'active' } }).then(refresh).catch((e) => toast(e.message, 'bad'))}>Re-activate</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {importing && <ImportDialog cls={cls} onClose={() => setImporting(false)} onDone={refresh} />}
      {adding && <AddStudent cls={cls} onClose={() => setAdding(false)} onDone={refresh} />}
      {acting && <EnrollmentAction cls={cls} row={acting} onClose={() => setActing(null)} onDone={refresh} />}
    </div>
  );
}

function EnrollmentAction({ cls, row, onClose, onDone }: { cls: any; row: any; onClose: () => void; onDone: () => void }) {
  const { data: classes } = useApi<any[]>('/classes');
  const [mode, setMode] = useState<'transfer' | 'dropped' | 'withdrawn'>('transfer');
  const [to, setTo] = useState(0);
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const go = () => run(() => (mode === 'transfer' ? api(`/enrollments/${row.enrollment_id}/transfer`, { body: { toClassId: to, note } }) : api(`/enrollments/${row.enrollment_id}/status`, { body: { status: mode, note } })), mode === 'transfer' ? 'Student transferred' : 'Enrollment updated').then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Dialog title={`${row.name_km ?? ''} ${row.name_latin ?? ''}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (mode === 'transfer' && !to)} onClick={go}>{mode === 'transfer' ? 'Transfer' : 'Save'}</button></>}>
      <div className="seg"><button className={mode === 'transfer' ? 'on' : ''} onClick={() => setMode('transfer')}>Transfer</button><button className={mode === 'dropped' ? 'on' : ''} onClick={() => setMode('dropped')}>Dropped</button><button className={mode === 'withdrawn' ? 'on' : ''} onClick={() => setMode('withdrawn')}>Withdrawn</button></div>
      {mode === 'transfer' && (
        <Field label="Move to class" hint={`Grades and attendance stay with ${cls.code}. The student starts the new class with an empty record.`}>
          <select id="tr-to" value={to} onChange={(e) => setTo(+e.target.value)}>
            <option value={0}>Choose…</option>
            {classes?.filter((c) => c.id !== cls.id && c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.code} — {c.course_name} ({c.term_name})</option>)}
          </select>
        </Field>
      )}
      {mode !== 'transfer' && <Notice tone="info">The student’s grades and attendance are kept. They no longer appear on new roll calls.</Notice>}
      <Field label="Note"><input id="tr-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function AddStudent({ cls, onClose, onDone }: { cls: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: '', nameKm: '', nameLatin: '', gender: '', email: '', phone: '' });
  const [existing, setExisting] = useState('');
  const { data: found } = useApi<any[]>(existing.trim().length >= 2 ? `/students?q=${encodeURIComponent(existing.trim())}` : null);
  const { busy, run } = useAction();
  return (
    <Dialog title={`Add a student to ${cls.code}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.code} onClick={() => run(() => api('/students', { body: { ...f, classId: cls.id } }), 'Student added').then((r) => { if (r) { onDone(); onClose(); } })}>Create and enroll</button></>}>
      <Field label="Find an existing student"><input id="as-find" value={existing} onChange={(e) => setExisting(e.target.value)} placeholder="ID or name" /></Field>
      {found && found.length > 0 && (
        <ul className="ledger panel">
          {found.slice(0, 6).map((s) => (
            <li key={s.id}><span className="mono">{s.student_code}</span><span className="grow">{s.name_km} {s.name_latin} <span className="faint xs">{s.classes}</span></span>
              <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/classes/${cls.id}/enroll`, { body: { studentIds: [s.id] } }), 'Student enrolled').then((r) => { if (r) { onDone(); onClose(); } })}>Enroll</button></li>
          ))}
        </ul>
      )}
      <hr className="divider" />
      <div className="form-grid">
        <Field label="Student ID" hint="Kept as text, so leading zeros stay."><input id="as-code" className="mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Khmer name"><input id="as-km" value={f.nameKm} onChange={(e) => setF({ ...f, nameKm: e.target.value })} /></Field>
        <Field label="Latin name"><input id="as-lat" value={f.nameLatin} onChange={(e) => setF({ ...f, nameLatin: e.target.value })} /></Field>
        <Field label="Gender"><select id="as-g" value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">—</option><option value="F">F</option><option value="M">M</option></select></Field>
        <Field label="Email"><input id="as-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><input id="as-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

const FIELDS = [
  ['student_code', 'Student ID', /id|code|អត្តលេខ|លេខ/i],
  ['name_km', 'Khmer name', /khmer|ខ្មែរ|ឈ្មោះ/i],
  ['name_latin', 'Latin name', /latin|english|name/i],
  ['gender', 'Gender', /gender|sex|ភេទ/i],
  ['email', 'Email', /mail/i],
  ['phone', 'Phone', /phone|tel|ទូរស័ព្ទ/i],
  ['notes', 'Notes', /note|remark/i],
] as const;

function ImportDialog({ cls, onClose, onDone }: { cls: any; onClose: () => void; onDone: () => void }) {
  const [sheet, setSheet] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<any[] | null>(null);
  const [issues, setIssues] = useState<any[]>([]);
  const { busy, run } = useAction();

  const onFile = (file: File) => run(async () => {
    const parsed = await api(`/import/parse?filename=${encodeURIComponent(file.name)}`, { raw: await file.arrayBuffer(), headers: { 'content-type': 'application/octet-stream' } });
    setSheet(parsed);
    const m: Record<string, number> = {};
    const used = new Set<number>();
    for (const [key, , re] of FIELDS) {
      const i = parsed.headers.findIndex((h: string, idx: number) => !used.has(idx) && re.test(h));
      if (i >= 0) { m[key] = i; used.add(i); }
    }
    setMap(m);
  });
  const buildRows = () => sheet!.rows.map((r, i) => {
    const o: any = { row: i + 2 };
    for (const [key] of FIELDS) if (map[key] !== undefined) o[key] = (r[map[key]] ?? '').trim();
    return o;
  });
  const validate = (list: any[]) => run(async () => {
    const r = await api(`/classes/${cls.id}/import/validate`, { body: { rows: list } });
    setRows(list);
    setIssues(r.issues);
  });
  const errors = issues.filter((i) => i.level === 'error');
  const edit = (rowNo: number, field: string, value: string) => setRows((rs) => rs!.map((r) => (r.row === rowNo ? { ...r, [field]: value } : r)));

  return (
    <Dialog wide title={`Import students into ${cls.code}`} onClose={onClose} footer={
      !sheet ? <button className="btn" onClick={onClose}>Cancel</button>
      : !rows ? <><button className="btn" onClick={() => setSheet(null)}>Choose another file</button><button className="btn primary" disabled={busy || map.student_code === undefined} onClick={() => validate(buildRows())}>Check {sheet.rows.length} rows</button></>
      : <><button className="btn" onClick={() => setRows(null)}>Back to columns</button><button className="btn" disabled={busy} onClick={() => validate(rows)}>Check again</button><button className="btn primary" disabled={busy || errors.length > 0} onClick={() => run(() => api(`/classes/${cls.id}/import/commit`, { body: { rows } })).then((r) => { if (r) { onDone(); onClose(); } })}>Import {rows.length} students</button></>
    }>
      {!sheet && (
        <div className="stack">
          <p className="muted">Upload an Excel (.xlsx) or CSV file with one student per row and a header row. You will match the columns and see every problem before anything is saved.</p>
          <input type="file" accept=".xlsx,.csv,text/csv" aria-label="Spreadsheet file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </div>
      )}
      {sheet && !rows && (
        <div className="stack">
          <h3>Match the columns</h3>
          <div className="form-grid">
            {FIELDS.map(([key, label]) => (
              <Field key={key} label={label + (key === 'student_code' ? ' (required)' : '')}>
                <select value={map[key] ?? -1} onChange={(e) => { const v = +e.target.value; const n = { ...map }; if (v < 0) delete n[key]; else n[key] = v; setMap(n); }}>
                  <option value={-1}>Not in the file</option>
                  {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <h3>Preview</h3>
          <div className="table-wrap panel">
            <table className="table">
              <thead><tr>{FIELDS.filter(([k]) => map[k] !== undefined).map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
              <tbody>{sheet.rows.slice(0, 5).map((r, i) => <tr key={i}>{FIELDS.filter(([k]) => map[k] !== undefined).map(([k]) => <td key={k} className={k === 'student_code' ? 'mono' : ''}>{r[map[k]]}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      {rows && (
        <div className="stack">
          {errors.length ? <Notice tone="bad">{errors.length} problem(s) must be fixed. Edit the cells below, then check again.</Notice> : <Notice tone="ok">No blocking problems. {issues.length ? `${issues.length} note(s) below.` : ''}</Notice>}
          <div className="table-wrap panel" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Row</th><th>Student ID</th><th>Khmer name</th><th>Latin name</th><th>Problems</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const mine = issues.filter((i) => i.row === r.row);
                  if (!mine.length && errors.length) return null;
                  return (
                    <tr key={r.row}>
                      <td className="mono faint">{r.row}</td>
                      {(['student_code', 'name_km', 'name_latin'] as const).map((k) => <td key={k}><input aria-label={`${k} row ${r.row}`} className={k === 'student_code' ? 'mono' : ''} value={r[k] ?? ''} onChange={(e) => edit(r.row, k, e.target.value)} style={mine.some((i) => i.field === k && i.level === 'error') ? { borderColor: 'var(--bad)' } : undefined} /></td>)}
                      <td className="small">{mine.map((i, j) => <div key={j} style={{ color: i.level === 'error' ? 'var(--bad)' : 'var(--warn)' }}>{i.message}</div>)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {errors.length > 0 && <p className="faint xs">Only rows with problems are shown.</p>}
        </div>
      )}
    </Dialog>
  );
}
