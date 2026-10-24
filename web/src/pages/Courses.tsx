import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Confirm, Dialog, Empty, ErrorNote, Field, Icon, Loading, MaterialStatus, Menu, Notice, useAction, useToast } from '../ui.tsx';

export function Courses() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<any[]>('/courses');
  const [creating, setCreating] = useState(false);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Courses')}</h1></div>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />New course</button>
      </div>
      {loading && !data ? <Loading /> : !data?.length ? <div className="panel"><Empty title="No courses yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create a course</button>} /></div> : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Course</th><th className="num">Lessons</th><th className="num">Parts</th><th>Materials ready</th><th className="num">Active classes</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className={c.archived ? 'is-dim' : ''}>
                  <td><span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: c.color }} /><Link to={`/courses/${c.id}`}><b className="mono">{c.code}</b> {c.name}</Link></span>{c.name_km && <div className="faint xs" style={{ paddingLeft: 17 }}>{c.name_km}</div>}</td>
                  <td className="num">{c.lessons}</td>
                  <td className="num">{c.parts}</td>
                  <td style={{ minWidth: 160 }}>
                    <div className="progress-track"><div className="bar" style={{ width: `${c.materials ? (c.ready / c.materials) * 100 : 0}%`, background: 'var(--ok)' }} /></div>
                    <div className="mono xs faint" style={{ marginTop: 3 }}>{c.ready} / {c.materials}</div>
                  </td>
                  <td className="num">{c.active_classes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CourseForm onClose={() => setCreating(false)} onDone={reload} />}
    </div>
  );
}

function CourseForm({ course, onClose, onDone }: { course?: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: course?.code ?? '', name: course?.name ?? '', nameKm: course?.name_km ?? '', description: course?.description ?? '', color: course?.color ?? '#2f5bd3', weeks: course?.weeks ?? 17 });
  const { busy, run } = useAction();
  return (
    <Dialog title={course ? 'Edit course' : 'New course'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.code || !f.name} onClick={() => run(() => (course ? api(`/courses/${course.id}`, { method: 'PUT', body: f }) : api('/courses', { body: f })), 'Course saved').then((r) => { if (r) { onDone(); onClose(); } })}>Save</button></>}>
      <div className="form-grid">
        <Field label="Code"><input id="co-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="WBD1" /></Field>
        <Field label="Name"><input id="co-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Web Development I" /></Field>
        <Field label="Khmer name"><input id="co-km" value={f.nameKm} onChange={(e) => setF({ ...f, nameKm: e.target.value })} /></Field>
        <Field label="Colour" hint="Used on the timetable and class lists."><input id="co-color" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
        {!course && <Field label="Weeks in the template"><input id="co-weeks" type="number" min={1} max={40} value={f.weeks} onChange={(e) => setF({ ...f, weeks: +e.target.value })} /></Field>}
      </div>
      <Field label="Description"><textarea id="co-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </Dialog>
  );
}

const ACTIVITIES = [['lesson', 'Lessons'], ['midterm_review', 'Midterm review'], ['midterm', 'Midterm exam'], ['capstone', 'Capstone'], ['final_review', 'Final review'], ['final', 'Final exam'], ['buffer', 'Buffer']];

export function CourseDetail() {
  const { id } = useParams();
  const { data: c, error, loading, reload } = useApi<any>(`/courses/${id}`);
  const [editing, setEditing] = useState(false);
  const [lessonForm, setLessonForm] = useState<any | null>(null);
  const [matForm, setMatForm] = useState<any | null>(null);
  const [partForm, setPartForm] = useState<any | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; go: () => void }>(null);
  const [template, setTemplate] = useState<any[] | null>(null);
  const nav = useNavigate();
  const { busy, run } = useAction();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !c) return <div className="page"><Loading rows={8} /></div>;
  if (!c) return null;
  const call = (path: string, method = 'POST', body?: any, msg?: string) => run(() => api(path, { method, body: body ?? {} }), msg).then(reload);
  const tpl = template ?? c.template;
  const lessonWeeks = tpl.filter((w: any) => w.activity === 'lesson').length;
  const partCount = c.lessons.reduce((s: number, l: any) => s + l.parts.length, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link to="/courses">Courses</Link></div>
          <h1 className="row" style={{ gap: 10 }}><span className="dot" style={{ background: c.color, width: 12, height: 12 }} /><span className="mono">{c.code}</span> {c.name}</h1>
          {c.description && <p className="sub">{c.description}</p>}
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" />Edit</button>
          <Menu label="More" items={[
            { label: c.archived ? 'Restore course' : 'Archive course', onSelect: () => call(`/courses/${c.id}`, 'PUT', { archived: !c.archived }, c.archived ? 'Course restored' : 'Course archived') },
            { label: 'Delete course…', danger: true, onSelect: () => setConfirm({ title: `Delete ${c.code}?`, body: 'Only possible while no class uses this course. Its lessons, parts and materials are deleted too.', go: () => run(() => api(`/courses/${c.id}`, { method: 'DELETE' }), 'Course deleted').then((r) => { if (r) nav('/courses'); }) }) },
          ]} />
        </div>
      </div>

      <div className="grid side">
        <section className="panel">
          <div className="panel-head"><h2>Curriculum</h2><button className="btn sm primary" onClick={() => setLessonForm({})}><Icon name="plus" />Add lesson</button></div>
          {!c.lessons.length ? <Empty title="No lessons yet" /> : (
            <ul className="ledger">
              {c.lessons.map((l: any, li: number) => (
                <li key={l.id} style={{ flexDirection: 'column', gap: 8 }}>
                  <div className="row between" style={{ width: '100%' }}>
                    <div><span className="eyebrow">Lesson {l.number}</span><h3>{l.title}</h3>{l.objectives && <div className="faint small">{l.objectives}</div>}</div>
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn sm ghost" aria-label="Move lesson up" disabled={li === 0 || busy} onClick={() => call(`/lessons/${l.id}/move`, 'POST', { direction: 'up' })}><Icon name="up" /></button>
                      <button className="btn sm ghost" aria-label="Move lesson down" disabled={li === c.lessons.length - 1 || busy} onClick={() => call(`/lessons/${l.id}/move`, 'POST', { direction: 'down' })}><Icon name="down" /></button>
                      <button className="btn sm ghost" aria-label="Edit lesson" onClick={() => setLessonForm(l)}><Icon name="edit" /></button>
                      <button className="btn sm ghost" aria-label="Delete lesson" onClick={() => setConfirm({ title: `Delete lesson ${l.number}?`, body: 'Its parts and materials are deleted too. This is refused if the lesson has been taught in any class.', go: () => call(`/lessons/${l.id}`, 'DELETE', undefined, 'Lesson deleted') })}><Icon name="trash" /></button>
                    </div>
                  </div>
                  <div className="stack" style={{ gap: 6, width: '100%' }}>
                    {l.parts.map((p: any, pi: number) => (
                      <div key={p.id} className="row" style={{ paddingLeft: 12, borderLeft: '2px solid var(--rule-strong)' }}>
                        <b className="mono">{l.number}{p.label}</b>
                        <span className="small" style={{ flex: 1 }}>{p.title ?? <span className="faint">Part {p.label}</span>}{p.taught && <span className="pill" style={{ marginLeft: 6 }}>taught</span>}</span>
                        <button className="btn sm ghost" aria-label="Move part up" disabled={pi === 0} onClick={() => call(`/parts/${p.id}/move`, 'POST', { direction: 'up' })}><Icon name="up" /></button>
                        <button className="btn sm ghost" aria-label="Move part down" disabled={pi === l.parts.length - 1} onClick={() => call(`/parts/${p.id}/move`, 'POST', { direction: 'down' })}><Icon name="down" /></button>
                        <button className="btn sm ghost" aria-label="Rename part" onClick={() => setPartForm({ ...p, code: `${l.number}${p.label}` })}><Icon name="edit" /></button>
                        {!p.taught && l.parts.length > 1 && <button className="btn sm ghost" aria-label="Delete part" onClick={() => setConfirm({ title: `Delete part ${l.number}${p.label}?`, body: 'Its materials stay with the lesson.', go: () => call(`/parts/${p.id}`, 'DELETE', undefined, 'Part deleted') })}><Icon name="trash" /></button>}
                      </div>
                    ))}
                    <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => call(`/lessons/${l.id}/parts`, 'POST', { label: String.fromCharCode(65 + l.parts.length) }, 'Part added')}><Icon name="plus" />Add part {String.fromCharCode(65 + l.parts.length)}</button>
                  </div>
                  <details className="more" style={{ width: '100%' }} open={l.materials.some((m: any) => m.status !== 'ready') && l.materials.length <= 3}>
                    <summary style={{ padding: '6px 0' }}>Materials · {l.materials.filter((m: any) => m.status === 'ready').length}/{l.materials.length} ready</summary>
                    {l.materials.map((m: any) => (
                      <div key={m.id} className="row" style={{ padding: '4px 0', borderTop: '1px dashed var(--rule)' }}>
                        <span className="pill">{m.kind}</span>
                        <span className="small" style={{ flex: 1, minWidth: 0 }}>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a> : m.title}{m.part_id && <span className="faint xs"> · part {l.parts.find((p: any) => p.id === m.part_id)?.label}</span>}</span>
                        <select aria-label={`Readiness of ${m.title}`} value={m.status} style={{ width: 130, minHeight: 28, padding: '2px 6px' }} onChange={(e) => call(`/materials/${m.id}`, 'PUT', { status: e.target.value })}>
                          <option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="ready">Ready</option>
                        </select>
                        <MaterialStatus status={m.status} />
                        <button className="btn sm ghost" aria-label="Edit material" onClick={() => setMatForm({ ...m, lessonId: l.id, parts: l.parts })}><Icon name="edit" /></button>
                      </div>
                    ))}
                    <button className="btn sm ghost" onClick={() => setMatForm({ lessonId: l.id, parts: l.parts, kind: 'slides', status: 'not_started' })}><Icon name="plus" />Add material</button>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>{tpl.length}-week template</h2>{template && <button className="btn sm primary" disabled={busy} onClick={() => run(() => api(`/courses/${c.id}/template`, { method: 'PUT', body: { weeks: template } }), 'Template saved').then(() => { setTemplate(null); reload(); })}>Save template</button>}</div>
          <div className="panel-body stack" style={{ gap: 8 }}>
            <p className="faint xs">Each lesson week takes the next lesson part: the Lecture teaches it, the Practice practises it. Exam weeks follow the term’s exam windows when those are set.</p>
            {lessonWeeks < partCount && <Notice tone="warn">{partCount} lesson parts but only {lessonWeeks} lesson weeks; the last {partCount - lessonWeeks} will not fit unless a week covers two parts.</Notice>}
            <table className="table">
              <thead><tr><th>Wk</th><th>Activity</th><th>Checkpoint</th></tr></thead>
              <tbody>
                {tpl.map((w: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{i + 1}</td>
                    <td><select aria-label={`Week ${i + 1} activity`} value={w.activity} onChange={(e) => setTemplate(tpl.map((x: any, j: number) => (j === i ? { ...x, activity: e.target.value } : x)))}>{ACTIVITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                    <td><input aria-label={`Week ${i + 1} checkpoint`} value={w.checkpoint ?? ''} placeholder="e.g. LAB 1" onChange={(e) => setTemplate(tpl.map((x: any, j: number) => (j === i ? { ...x, checkpoint: e.target.value } : x)))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <button className="btn sm" onClick={() => setTemplate([...tpl, { activity: 'lesson' }])}><Icon name="plus" />Add week</button>
              {tpl.length > 1 && <button className="btn sm" onClick={() => setTemplate(tpl.slice(0, -1))}>Remove last week</button>}
            </div>
          </div>
        </section>
      </div>

      {editing && <CourseForm course={c} onClose={() => setEditing(false)} onDone={reload} />}
      {lessonForm && <LessonForm courseId={c.id} lesson={lessonForm.id ? lessonForm : null} onClose={() => setLessonForm(null)} onDone={reload} />}
      {matForm && <MaterialForm m={matForm} onClose={() => setMatForm(null)} onDone={reload} />}
      {partForm && <PartForm p={partForm} onClose={() => setPartForm(null)} onDone={reload} />}
      {confirm && <Confirm title={confirm.title} body={confirm.body} confirmLabel="Delete" danger onConfirm={confirm.go} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function LessonForm({ courseId, lesson, onClose, onDone }: { courseId: number; lesson: any | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: lesson?.title ?? '', objectives: lesson?.objectives ?? '', description: lesson?.description ?? '', estMinutes: lesson?.est_minutes ?? 180, parts: 'A' });
  const { busy, run } = useAction();
  const save = () => run(() => (lesson ? api(`/lessons/${lesson.id}`, { method: 'PUT', body: f }) : api(`/courses/${courseId}/lessons`, { body: { ...f, parts: f.parts.split(/[\s,]+/).filter(Boolean) } })), 'Lesson saved').then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Dialog title={lesson ? 'Edit lesson' : 'New lesson'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.title} onClick={save}>Save</button></>}>
      <Field label="Title"><input id="l-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Learning objectives"><textarea id="l-obj" value={f.objectives} onChange={(e) => setF({ ...f, objectives: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="Estimated minutes"><input id="l-min" type="number" value={f.estMinutes} onChange={(e) => setF({ ...f, estMinutes: +e.target.value })} /></Field>
        {!lesson && <Field label="Parts" hint="Labels separated by commas, e.g. A, B"><input id="l-parts" value={f.parts} onChange={(e) => setF({ ...f, parts: e.target.value })} /></Field>}
      </div>
      <Field label="Description"><textarea id="l-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </Dialog>
  );
}

function MaterialForm({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: m.kind, title: m.title ?? '', url: m.url ?? '', status: m.status, partId: m.part_id ?? null });
  const { busy, run } = useAction();
  const save = () => run(() => (m.id ? api(`/materials/${m.id}`, { method: 'PUT', body: f }) : api('/materials', { body: { ...f, lessonId: m.lessonId } })), 'Material saved').then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Dialog title={m.id ? 'Edit material' : 'New material'} onClose={onClose} footer={<>
      {m.id && <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/materials/${m.id}`, { method: 'DELETE' }), 'Material removed').then(() => { onDone(); onClose(); })}>Remove</button>}
      <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.title} onClick={save}>Save</button>
    </>}>
      <div className="form-grid">
        <Field label="Type"><select id="m-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="slides">Slides</option><option value="exercise">Exercises</option><option value="code">Example code</option><option value="lab">Lab instructions</option><option value="other">Other</option></select></Field>
        <Field label="Readiness"><select id="m-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="ready">Ready</option></select></Field>
        <Field label="For part"><select id="m-part" value={f.partId ?? ''} onChange={(e) => setF({ ...f, partId: e.target.value ? +e.target.value : null })}><option value="">Whole lesson</option>{m.parts.map((p: any) => <option key={p.id} value={p.id}>Part {p.label}</option>)}</select></Field>
      </div>
      <Field label="Title"><input id="m-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Link" hint="Google Drive, GitHub or any URL."><input id="m-url" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
    </Dialog>
  );
}

function PartForm({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ label: p.label, title: p.title ?? '', estMinutes: p.est_minutes ?? '' });
  const { busy, run } = useAction();
  return (
    <Dialog title={`Part ${p.code}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.label.trim()} onClick={() => run(() => api(`/parts/${p.id}`, { method: 'PUT', body: f }), 'Part saved').then((r) => { if (r) { onDone(); onClose(); } })}>Save</button></>}>
      <div className="form-grid">
        <Field label="Label"><input id="pf-label" value={f.label} maxLength={4} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Minutes (optional)"><input id="pf-min" type="number" min={1} value={f.estMinutes} onChange={(e) => setF({ ...f, estMinutes: e.target.value })} /></Field>
      </div>
      <Field label="Title"><input id="pf-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    </Dialog>
  );
}
