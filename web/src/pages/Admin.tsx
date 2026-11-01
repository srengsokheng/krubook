import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { Confirm, D, Dialog, Empty, ErrorNote, Field, Icon, Loading, Menu, Notice, Pill, useAction } from '../ui.tsx';
import type { Me } from '../App.tsx';

// Accounts: create teacher accounts, set how long each may make changes (the paid-until date),
// switch features off, suspend, reset passwords. Administrators manage the account only; a
// teacher's classes, students and pay stay private to that teacher.

type Account = {
  id: number; email: string; name: string; role: 'admin' | 'teacher'; status: 'active' | 'suspended'; accessUntil: string | null; expired: boolean;
  featuresOff: string[]; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string; note: string | null; unclaimed: boolean;
  counts: { classes: number; students: number };
};
type Feature = { key: string; label: string };

export function Admin({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<{ accounts: Account[]; features: Feature[] }>('/admin/accounts');
  const [edit, setEdit] = useState<Partial<Account> | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string; isNew: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown>; done: string } | null>(null);
  const { run } = useAction();
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="page"><Loading rows={6} /></div>;
  if (!data) return null;
  const teachers = data.accounts.filter((a) => a.role === 'teacher');
  const active = teachers.filter((a) => a.status === 'active' && !a.expired).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="sub">{teachers.length} teacher account{teachers.length === 1 ? '' : 's'} · {active} active. Each teacher’s classes, students and pay are private to them.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ role: 'teacher', featuresOff: [], accessUntil: null })}><Icon name="plus" />Add account</button>
      </div>

      <div className="panel table-wrap">
        <table className="table mobile-cards">
          <thead><tr><th>Name</th><th>Status</th><th>Access until</th><th>Features</th><th className="num">Classes</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>{data.accounts.map((a) => (
            <tr key={a.id} className={a.status === 'suspended' ? 'is-dim' : ''}>
              <td data-label="Name"><span><b>{a.name}</b>{a.role === 'admin' && <Pill tone="ink">admin</Pill>}{a.id === me.id && <span className="faint xs"> (you)</span>}<div className="faint xs">{a.email}</div>{a.note && <div className="faint xs">{a.note}</div>}</span></td>
              <td data-label="Status">{a.status === 'suspended' ? <Pill tone="bad">suspended</Pill> : a.expired ? <Pill tone="warn">expired</Pill> : a.mustChangePassword ? <Pill tone="accent">waiting for first sign-in</Pill> : <Pill tone="ok">active</Pill>}</td>
              <td data-label="Access until" className="mono small">{a.role === 'admin' ? <span className="faint">no limit</span> : a.accessUntil ? <D date={a.accessUntil} year /> : <span className="faint">no end date</span>}</td>
              <td data-label="Features" className="small">{a.featuresOff.length ? <span>All except {a.featuresOff.map((k) => data.features.find((f) => f.key === k)?.label ?? k).join(', ')}</span> : <span className="faint">All</span>}</td>
              <td data-label="Classes" className="num">{a.counts.classes}<div className="faint xs">{a.counts.students} students</div></td>
              <td data-label="Last sign-in" className="small">{a.lastLoginAt ? <span className="mono">{a.lastLoginAt.slice(0, 16)}</span> : <span className="faint">never</span>}</td>
              <td data-label="" style={{ textAlign: 'right' }}>
                <Menu label="Manage" items={[
                  { label: 'Edit…', onSelect: () => setEdit(a) },
                  { label: 'Extend access by 1 month', hidden: a.role === 'admin', onSelect: () => run(() => api(`/admin/accounts/${a.id}`, { method: 'PUT', body: { accessUntil: extend(a.accessUntil, 1) } }), `Access extended to ${extend(a.accessUntil, 1)}`).then(reload) },
                  { label: 'Reset password…', hidden: a.id === me.id, onSelect: () => setConfirm({ title: `Reset ${a.name}’s password?`, body: 'They are signed out everywhere and get a temporary password, which they must change when they sign in.', label: 'Reset password', run: () => api(`/admin/accounts/${a.id}/reset-password`, { method: 'POST' }).then((r) => setSecret({ email: a.email, password: r.temporaryPassword, isNew: false })), done: '' }) },
                  { label: 'Sign out everywhere', hidden: a.id === me.id, onSelect: () => run(() => api(`/admin/accounts/${a.id}/sign-out`, { method: 'POST' }), `${a.name} is signed out`) },
                  { label: a.status === 'suspended' ? 'Reactivate' : 'Suspend…', hidden: a.id === me.id, danger: a.status !== 'suspended', onSelect: () => a.status === 'suspended'
                    ? run(() => api(`/admin/accounts/${a.id}`, { method: 'PUT', body: { status: 'active' } }), `${a.name} is active again`).then(reload)
                    : setConfirm({ title: `Suspend ${a.name}?`, body: 'They are signed out at once and cannot sign in until you reactivate the account. Their data is kept.', label: 'Suspend', run: () => api(`/admin/accounts/${a.id}`, { method: 'PUT', body: { status: 'suspended' } }), done: 'Account suspended' }) },
                  { label: 'Delete…', hidden: a.id === me.id || a.counts.classes > 0 || a.counts.students > 0, danger: true, onSelect: () => setConfirm({ title: `Delete ${a.name}?`, body: 'Only accounts without any courses, classes or students can be deleted. This cannot be undone.', label: 'Delete', run: () => api(`/admin/accounts/${a.id}`, { method: 'DELETE' }), done: 'Account deleted' }) },
                ]} />
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!teachers.length && <Empty title="No teacher accounts yet">Add an account for each teacher who uses KruBook. They get a temporary password and choose their own at first sign-in.</Empty>}
      </div>
      <p className="faint xs">After the access-until date a teacher can still sign in, view and export, but cannot change anything until you extend it. Administrators have no limit.</p>

      {edit && <AccountForm a={edit} features={data.features} isSelf={edit.id === me.id} onClose={() => setEdit(null)} onSaved={(r) => { reload(); if (r?.temporaryPassword) setSecret({ email: r.account.email, password: r.temporaryPassword, isNew: true }); }} />}
      {secret && <TemporaryPassword {...secret} onClose={() => setSecret(null)} />}
      {confirm && <Confirm title={confirm.title} body={confirm.body} confirmLabel={confirm.label} danger onConfirm={() => run(confirm.run, confirm.done || undefined).then(reload)} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** The date `months` months after the later of today and `from` (YYYY-MM-DD). */
function extend(from: string | null, months: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = from && from > today ? from : today;
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function AccountForm({ a, features, isSelf, onClose, onSaved }: { a: Partial<Account>; features: Feature[]; isSelf: boolean; onClose: () => void; onSaved: (r: any) => void }) {
  const [f, setF] = useState({ name: a.name ?? '', email: a.email ?? '', role: a.role ?? 'teacher', accessUntil: a.accessUntil ?? '', featuresOff: a.featuresOff ?? [], note: a.note ?? '' });
  const { busy, run } = useAction();
  const body = { ...f, accessUntil: f.accessUntil || null };
  const save = () => run(() => (a.id ? api(`/admin/accounts/${a.id}`, { method: 'PUT', body }) : api('/admin/accounts', { body })), a.id ? 'Account saved' : undefined).then((r) => { if (r) { onSaved(r); onClose(); } });
  const toggle = (k: string, on: boolean) => setF({ ...f, featuresOff: on ? f.featuresOff.filter((x) => x !== k) : [...f.featuresOff, k] });
  return (
    <Dialog title={a.id ? `Edit ${a.name}` : 'Add account'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name.trim() || !f.email.trim()} onClick={save}>{a.id ? 'Save' : 'Create account'}</button></>}>
      <div className="form-grid">
        <Field label="Name"><input id="acc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email (sign-in)"><input id="acc-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><select id="acc-role" value={f.role} disabled={isSelf} onChange={(e) => setF({ ...f, role: e.target.value as 'admin' | 'teacher' })}><option value="teacher">Teacher</option><option value="admin">Administrator</option></select></Field>
        {f.role === 'teacher' && <Field label="Access until" hint="Last day they can make changes. Leave empty for no end date."><input id="acc-until" type="date" value={f.accessUntil} onChange={(e) => setF({ ...f, accessUntil: e.target.value })} /></Field>}
      </div>
      {f.role === 'teacher' && (
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: '8px 0' }}>
          <legend className="small muted" style={{ fontWeight: 500, marginBottom: 4 }}>Features</legend>
          {features.map((x) => <label key={x.key} className="check"><input type="checkbox" checked={!f.featuresOff.includes(x.key)} onChange={(e) => toggle(x.key, e.target.checked)} /> {x.label}</label>)}
        </fieldset>
      )}
      {f.role === 'admin' && <Notice tone="info">Administrators manage accounts and the whole-system backup. They still cannot open other teachers’ classes, students or pay.</Notice>}
      <Field label="Note (only admins see it)"><input id="acc-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. paid $10 for November by ABA" /></Field>
      {!a.id && <p className="faint xs">A temporary password is created and shown once. The teacher must change it when they first sign in.</p>}
    </Dialog>
  );
}

function TemporaryPassword({ email, password, isNew, onClose }: { email: string; password: string; isNew: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `KruBook: ${location.origin}\nEmail: ${email}\nTemporary password: ${password}\nYou will choose your own password when you sign in.`;
  return (
    <Dialog title={isNew ? 'Account created' : 'Password reset'} onClose={onClose} footer={<><button className="btn" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy sign-in details'}</button><button className="btn primary" onClick={onClose}>Done</button></>}>
      <p className="muted small">Send these to the teacher. The temporary password is shown only now.</p>
      <dl className="kv">
        <dt>Address</dt><dd className="mono">{location.origin}</dd>
        <dt>Email</dt><dd className="mono">{email}</dd>
        <dt>Temporary password</dt><dd className="mono" style={{ fontSize: '1.1rem' }}><b>{password}</b></dd>
      </dl>
    </Dialog>
  );
}
