import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { D, Icon, Notice, plural, useAction } from '../ui.tsx';

// Drop the teaching workbook here: the server reads it into a scratch copy, compares it with the
// app and lists what would change. Nothing is saved until "Apply", which re-reads the same file and
// refuses if the result no longer matches the preview.

type Preview = { plan: any; notes: string[]; summary: string[] };

export function ImportWorkbook() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<any | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();

  const send = async (path: string, f: File) => api(path, { raw: await f.arrayBuffer(), headers: { 'content-type': 'application/octet-stream' } });
  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f); setPreview(null); setDone(null);
    void run(() => send('/workbook/preview', f)).then((r) => { if (r) setPreview(r); else setFile(null); });
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); };
  const apply = () => run(() => send(`/workbook/apply?fingerprint=${preview!.plan.fingerprint}`, file!)).then((r) => { if (r) { setDone(r); setPreview(null); } });

  const p = preview?.plan;
  const total = p ? p.add.length + p.update.length + p.teach.length : 0;
  const kept = p ? Object.values(p.kept as Record<string, string[]>).reduce((n, l) => n + l.length, 0) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Update from Excel</h1>
          <p className="sub">Drop your teaching workbook here. You see every change before anything is saved.</p>
        </div>
      </div>

      <div className={`dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
        <Icon name="upload" />
        <div>
          {file ? <b>{file.name}</b> : <b>Drop the .xlsx workbook here</b>}
          <div className="faint small">{busy ? 'Reading the workbook…' : file ? 'Drop another file to start again.' : 'Teaching_Schedule_and_Progress.xlsx, with its Weekly Schedule, Term Plan and Gradebook sheets.'}</div>
        </div>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Choose file</button>
        <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Workbook file" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      {done && (
        <Notice tone={done.failed.length ? 'warn' : 'ok'}>
          Saved: {plural(done.added, 'score added', 'scores added')}, {plural(done.updated, 'score updated', 'scores updated')}, {plural(done.taught, 'session recorded as taught', 'sessions recorded as taught')}.
          {done.failed.length > 0 && <> {done.failed.length} could not be saved: {done.failed.map((f: any) => `${f.what} (${f.message})`).join('; ')}.</>}
          {done.taught > 0 && <> Check the <Link to="/review">Review</Link> page and class plans for any schedule changes to approve.</>}
        </Notice>
      )}

      {p && (
        <>
          <div className="figures">
            <div className="figure"><span className="eyebrow">Scores to add</span><span className="value">{p.add.length}</span></div>
            <div className="figure"><span className="eyebrow">Scores to update</span><span className="value">{p.update.length}</span></div>
            <div className="figure"><span className="eyebrow">Sessions taught</span><span className="value">{p.teach.length}</span><span className="faint xs">to record from the workbook</span></div>
            <div className="figure"><span className="eyebrow">Left as they are</span><span className="value">{kept}</span><span className="faint xs">listed below</span></div>
          </div>

          {total === 0 ? <Notice tone="info">Nothing in this workbook needs saving{kept ? "; the differences below are kept as they are in the app" : ""}.</Notice> : (
            <div className="row between">
              <p className="faint small">Scores you edited in the app are never overwritten. Students are matched by class and name.</p>
              <button className="btn primary" disabled={busy} onClick={apply}><Icon name="check" />Apply {plural(total, 'change', 'changes')}</button>
            </div>
          )}

          {p.add.length > 0 && <ScoreTable title="Scores to add" rows={p.add} />}
          {p.update.length > 0 && <ScoreTable title="Scores to update" rows={p.update} changed />}
          {p.teach.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Sessions to record as taught</h2><span className="faint small">{p.teach.length}</span></div>
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Class</th><th>Date</th><th>Start</th></tr></thead>
                  <tbody>{p.teach.map((s: any) => <tr key={s.sessionId}><td className="mono">{s.classCode}</td><td className="mono small"><D date={s.date} year /></td><td className="mono small">{s.start}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="panel-body faint xs">Recorded with the planned lesson part and the full session length, as on the Review page.</p>
            </section>
          )}

          {kept > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Left as they are</h2></div>
              <Kept title="Scores you edited in the app" items={p.kept.editedInApp} />
              <Kept title="Attendance points the app calculates from roll calls" items={p.kept.attendanceCalculated} />
              <Kept title="Students in the workbook or the app only" items={p.kept.students} />
              <Kept title="Scores with no matching student or grade column" items={p.kept.unmatched} />
              <Kept title="Other session differences" items={p.kept.sessions} />
            </section>
          )}

          {preview!.notes.length > 0 && (
            <section className="panel">
              <details className="more" style={{ borderTop: 0 }}>
                <summary>Notes from reading the workbook ({preview!.notes.length})</summary>
                <ul className="panel-body small muted stack" style={{ gap: 4, margin: 0, paddingLeft: 32 }}>{preview!.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </details>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ScoreTable({ title, rows, changed }: { title: string; rows: any[]; changed?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2><span className="faint small">{rows.length}</span></div>
      <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>Class</th><th>Student</th><th>Grade column</th><th className="num">{changed ? 'App → workbook' : 'Score'}</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={`${c.enrollmentId}:${c.componentId}`}>
              <td className="mono">{c.classCode}</td>
              <td>{c.student} <span className="faint xs mono">{c.studentCode}</span></td>
              <td className="small">{c.component}</td>
              <td className="num mono">{changed ? <>{c.old} → <b>{c.value}</b></> : c.value}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function Kept({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <details className="more">
      <summary>{title} ({items.length})</summary>
      <ul className="small muted" style={{ margin: 0, padding: '0 16px 12px 32px' }}>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </details>
  );
}
