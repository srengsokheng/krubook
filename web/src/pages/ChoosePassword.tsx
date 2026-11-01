import { useState } from 'react';
import { api } from '../api.ts';
import { ErrorNote, Field } from '../ui.tsx';
import type { Me } from '../App.tsx';

// Shown after signing in with a temporary password from the administrator: nothing else opens
// until the teacher chooses their own.
export function ChoosePassword({ me, onDone, onSignOut }: { me: Me; onDone: () => void; onSignOut: () => void }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) { setError(new Error('The two new passwords do not match.')); return; }
    setBusy(true);
    try {
      await api('/account/password', { body: { current: f.current, next: f.next } });
      onDone();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <section className="login-art">
        <div className="ruled" />
        <div className="brand-mark" style={{ fontSize: '1.1rem' }}>Kru<b style={{ color: 'var(--marker)' }}>Book</b> · សៀវភៅគ្រូ</div>
        <div className="big">Welcome,<br />{me.name}.</div>
        <p style={{ maxWidth: 420, opacity: 0.75 }}>Your classes, roll calls, gradebooks and pay are yours alone. Nobody else, administrators included, can open them.</p>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <h1>Choose your password</h1>
          <p className="muted small">You signed in with a temporary password. Choose your own to continue.</p>
          <ErrorNote error={error} />
          <Field label="Temporary password"><input id="cp-current" type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 8 characters."><input id="cp-next" type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
          <Field label="New password again"><input id="cp-again" type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
          <button className="btn primary" disabled={busy} style={{ height: 40 }}>Save and continue</button>
          <button type="button" className="btn ghost" onClick={onSignOut}>Sign out</button>
        </form>
      </section>
    </div>
  );
}
