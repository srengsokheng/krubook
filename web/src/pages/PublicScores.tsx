import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../ui.tsx';

// What students see through a score link: their class's marks, no sign-in. It refreshes every
// 30 seconds, so marks the teacher enters show up on their own. Works on phones; the student can
// search for their own ID.

type Data = {
  classCode: string; course: string; teacher: string; showNames: boolean; targetTotal: number; passMark: number;
  columns: Array<{ id: number; name: string; max: number }>;
  rows: Array<{ code: string; nameKm?: string | null; nameLatin?: string | null; values: Array<number | null>; total: number; result: 'pass' | 'fail' | null; label: string }>;
  expiresAt: string; now: string;
};

const fmt = (n: number | null) => (n == null ? '–' : String(Math.round(n * 100) / 100));
/** "2026-11-19 08:00:00" (UTC) → local "Thu 19 Nov, 3:00 PM". */
const local = (utc: string) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function PublicScores({ token }: { token: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/public/scores/${encodeURIComponent(token)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setError(j?.error ?? 'This link cannot be opened.'); setData(null); return; }
      setData(j); setError(null); setUpdated(new Date());
    } catch {
      setError((e) => e ?? null); // offline for a moment: keep showing the last marks
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    document.title = 'Class scores';
    const meta = document.createElement('meta');
    meta.name = 'robots'; meta.content = 'noindex, nofollow';
    document.head.append(meta);
    return () => { clearInterval(t); meta.remove(); };
  }, [load]);

  if (error && !data) {
    return (
      <div className="public-scores">
        <div className="panel" style={{ maxWidth: 520, margin: '15vh auto 0', padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 'var(--fs-lg)' }}>{error}</h1>
          <p className="faint small">មិនអាចបើកតំណនេះបានទេ។ សូមសួរលោកគ្រូអ្នកគ្រូរបស់អ្នក។</p>
        </div>
      </div>
    );
  }
  if (!data) return <div className="public-scores"><p className="faint" style={{ textAlign: 'center', marginTop: '20vh' }}>Loading…</p></div>;

  const q = query.trim().toLowerCase();
  const rows = data.rows.filter((r) => !q || r.code.toLowerCase().includes(q) || (r.nameLatin ?? '').toLowerCase().includes(q) || (r.nameKm ?? '').includes(query.trim()));
  return (
    <div className="public-scores">
      <header className="stack" style={{ gap: 4 }}>
        <div className="eyebrow">ពិន្ទុថ្នាក់ · Class scores</div>
        <h1 style={{ margin: 0 }}><span className="mono">{data.classCode}</span> · {data.course}</h1>
        <div className="faint small">
          {data.teacher} · total out of {data.targetTotal}, pass from {data.passMark}
          {updated && <> · updated {updated.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</>}
          {' '}· link open until {local(data.expiresAt)}
        </div>
      </header>
      <div className="search" style={{ maxWidth: 360 }}>
        <Icon name="search" />
        <input aria-label="Find your ID or name" placeholder={data.showNames ? 'Find your ID or name · ស្វែងរកអត្តលេខ' : 'Find your ID · ស្វែងរកអត្តលេខ'} value={query} onChange={(e) => setQuery(e.target.value)} inputMode="search" />
      </div>
      {/* Phones: one card per student, every mark visible without scrolling sideways. */}
      <ul className="public-cards">
        {rows.map((r) => (
          <li key={r.code} className="panel">
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span><b className="mono">{r.code}</b>{data.showNames && <> · {r.nameLatin || r.nameKm}</>}</span>
              {r.result ? <span className={`pill ${r.result === 'pass' ? 'ok' : 'bad'}`}>{r.label}</span> : <span className="faint xs">in progress</span>}
            </div>
            <dl>
              {data.columns.map((c, i) => <div key={c.id}><dt>{c.name}</dt><dd className="mono">{fmt(r.values[i] ?? null)}<span className="faint">/{c.max}</span></dd></div>)}
              <div className="total"><dt>Total</dt><dd className="mono"><b>{fmt(r.total)}</b><span className="faint">/{data.targetTotal}</span></dd></div>
            </dl>
          </li>
        ))}
        {!rows.length && <li className="faint small">No student matches.</li>}
      </ul>
      <div className="panel public-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="table public-table">
          <thead>
            <tr>
              <th>ID</th>
              {data.showNames && <th>Name</th>}
              {data.columns.map((c) => <th key={c.id} className="num">{c.name}<div className="faint xs">/{c.max}</div></th>)}
              <th className="num">Total<div className="faint xs">/{data.targetTotal}</div></th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="mono">{r.code}</td>
                {data.showNames && <td>{r.nameLatin || r.nameKm}{r.nameKm && r.nameLatin && <div className="faint xs">{r.nameKm}</div>}</td>}
                {r.values.map((v, i) => <td key={i} className="num mono">{fmt(v)}</td>)}
                <td className="num mono"><b>{fmt(r.total)}</b></td>
                <td>{r.result ? <span className={`pill ${r.result === 'pass' ? 'ok' : 'bad'}`}>{r.label}</span> : <span className="faint xs">in progress</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={data.columns.length + 4} className="faint small">No student matches.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="faint xs">“–” means not marked yet. This page updates by itself.</p>
    </div>
  );
}
