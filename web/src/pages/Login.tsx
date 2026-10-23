import { useState } from 'react';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote, Field } from '../ui.tsx';
import type { Me } from '../App.tsx';

export function Login({ needsSetup, onSignedIn }: { needsSetup: boolean; onSignedIn: (u: Me) => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(needsSetup ? '/auth/setup' : '/auth/login', { body: { email, password, name } });
      onSignedIn(r.user);
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
        <div className="big">The register,<br />the plan and<br />the gradebook. <span>One place.</span></div>
        <p style={{ maxWidth: 420, opacity: 0.75 }}>Term plans built from real dates, attendance marked in a tap, and totals that add up to 100 every time.</p>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <h1>{needsSetup ? 'Create the first account' : t('Sign in')}</h1>
          {needsSetup && <p className="muted small">This account becomes the administrator. Cambodian public holidays for 2026–27 are added to start you off.</p>}
          <ErrorNote error={error} />
          {needsSetup && <Field label="Your name"><input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></Field>}
          <Field label={t('Email')}><input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></Field>
          <Field label={t('Password')} hint={needsSetup ? 'At least 8 characters.' : undefined}><input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={needsSetup ? 'new-password' : 'current-password'} /></Field>
          <button className="btn primary" disabled={busy} style={{ height: 40 }}>{needsSetup ? 'Create account' : t('Sign in')}</button>
          {!needsSetup && <p className="faint xs">Accounts are created by the administrator. There is no public sign-up.</p>}
        </form>
      </section>
    </div>
  );
}
