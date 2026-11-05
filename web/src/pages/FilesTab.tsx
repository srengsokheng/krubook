import { useRef, useState } from 'react';
import { api, download, useApi } from '../api.ts';
import { Confirm, D, Empty, ErrorNote, Field, Icon, Loading, Menu, useAction, useToast } from '../ui.tsx';

// Exam papers and other files kept with a class: the midterm and final papers (and anything else,
// such as answer keys) so next term's exam can start from them. Files are private to the teacher.

const KINDS = [['midterm', 'Midterm exam'], ['final', 'Final exam'], ['other', 'Other files']] as const;
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function FilesTab({ cls }: { cls: any }) {
  const { data, error, loading, reload } = useApi<any[]>(`/classes/${cls.id}/files`);
  const [kind, setKind] = useState<string>('midterm');
  const [title, setTitle] = useState('');
  const [del, setDel] = useState<any | null>(null);
  const [rename, setRename] = useState<any | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      const q = new URLSearchParams({ kind, filename: f.name, ...(title.trim() && files.length === 1 ? { title: title.trim() } : {}) });
      const raw = await f.arrayBuffer();
      await run(() => api(`/classes/${cls.id}/files?${q}`, { raw, headers: { 'content-type': 'application/octet-stream' } }), `${f.name} uploaded`);
    }
    setTitle('');
    if (input.current) input.current.value = '';
    reload();
  };

  if (error) return <ErrorNote error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={4} />;
  const files = data ?? [];
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h2>Upload</h2></div>
        <div className="panel-body stack">
          <div className="form-grid">
            <Field label="Kind"><select id="f-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Title (optional)" hint="Defaults to the file name."><input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Midterm 2026 — version A" /></Field>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload" />Choose files</button>
            <span className="faint xs">Word, PDF, Excel, PowerPoint, images, code or zip, up to 25 MB each.</span>
            <input ref={input} type="file" multiple hidden aria-label="Files to upload" accept=".docx,.doc,.pdf,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.zip,.cpp,.h" onChange={(e) => void upload(e.target.files)} />
          </div>
        </div>
      </section>

      {KINDS.map(([k, label]) => {
        const list = files.filter((f) => f.kind === k);
        return (
          <section key={k} className="panel">
            <div className="panel-head"><h2>{label}</h2><span className="faint small">{list.length}</span></div>
            {list.length ? (
              <ul className="ledger">
                {list.map((f) => (
                  <li key={f.id} style={{ alignItems: 'center' }}>
                    <span className="file-ico" aria-hidden="true"><Icon name="book" /></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ overflowWrap: 'anywhere' }}><b>{f.title}</b></div>
                      <div className="faint xs" style={{ overflowWrap: 'anywhere' }}>{f.filename} · {size(f.size)} · <D date={f.createdAt.slice(0, 10)} year /></div>
                    </div>
                    <button className="btn sm" onClick={() => download(`/files/${f.id}`).catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Download</button>
                    <Menu label="More" items={[
                      { label: 'Rename…', onSelect: () => setRename({ ...f }) },
                      ...KINDS.filter(([x]) => x !== f.kind).map(([x, l]) => ({ label: `Move to ${l}`, onSelect: () => run(() => api(`/files/${f.id}`, { method: 'PUT', body: { kind: x } }), 'Moved').then(reload) })),
                      { label: 'Delete…', danger: true, onSelect: () => setDel(f) },
                    ]} />
                  </li>
                ))}
              </ul>
            ) : <Empty title={`No ${label.toLowerCase()} yet`}>{k === 'other' ? 'Answer keys, marking sheets or anything else for this class.' : `Upload the ${label.toLowerCase()} paper so the next exam can start from it.`}</Empty>}
          </section>
        );
      })}

      {del && <Confirm title={`Delete “${del.title}”?`} body="The file is removed from KruBook. Keep a copy if you still need it." confirmLabel="Delete" danger onConfirm={() => run(() => api(`/files/${del.id}`, { method: 'DELETE' }), 'File deleted').then(reload)} onClose={() => setDel(null)} />}
      {rename && <Confirm title="Rename file" body={<Field label="Title"><input id="f-rename" value={rename.title} onChange={(e) => setRename({ ...rename, title: e.target.value })} /></Field>} confirmLabel="Save" onConfirm={() => run(() => api(`/files/${rename.id}`, { method: 'PUT', body: { title: rename.title } }), 'Renamed').then(reload)} onClose={() => setRename(null)} />}
    </div>
  );
}
