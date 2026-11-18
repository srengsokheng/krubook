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

  // Students are listed by name (the IDs on the list are not official); with "ID only" links, by ID.
  const label = (r: Data['rows'][number]) => (data.showNames ? r.nameLatin || r.nameKm || r.code : r.code);
  const q = query.trim().toLowerCase();
  const rows = data.rows
    .filter((r) => !q || label(r).toLowerCase().includes(q) || (r.nameKm ?? '').includes(query.trim()))
    .sort((a, b) => label(a).localeCompare(label(b), 'en', { numeric: true }));
  // Only columns someone has a mark in; the others appear once the first mark is entered.
  const shown = data.columns.map((c, i) => ({ ...c, i })).filter((c) => data.rows.some((r) => r.values[c.i] != null));
  const result = (r: Data['rows'][number]) => r.result ? <span className={`pill ${r.result === 'pass' ? 'ok' : 'bad'}`}>{r.label}</span> : null;
  const ago = updated ? Math.max(0, Math.round((Date.now() - updated.getTime()) / 60000)) : null;
  return (
    <div className="public-scores">
      <header className="public-head">
        <h1>{data.classCode} <span>{data.course}</span></h1>
        <div className="faint xs">Updated {ago === null || ago < 1 ? 'just now' : `${ago} min ago`} · out of {data.targetTotal}</div>
      </header>
      <div className="public-search">
        <div className="search">
          <Icon name="search" />
          <input aria-label="Search your name" placeholder={data.showNames ? 'Search your name' : 'Search your ID'} value={query} onChange={(e) => setQuery(e.target.value)} inputMode="search" />
        </div>
      </div>
      {/* Phones: one short line per student; tap to see the marks. */}
      <ul className="public-list panel">
        {rows.map((r) => (
          <li key={r.code}>
            <details open={rows.length === 1}>
              <summary>
                <span className="who">{label(r)}{data.showNames && r.nameKm && r.nameLatin && <span className="faint xs"> {r.nameKm}</span>}</span>
                <span className="mono"><b>{fmt(r.total)}</b></span>
                {result(r)}
              </summary>
              {shown.length ? (
                <dl>{shown.map((c) => <div key={c.id}><dt>{c.name}</dt><dd className="mono">{fmt(r.values[c.i] ?? null)}<span className="faint">/{c.max}</span></dd></div>)}</dl>
              ) : <p className="faint xs" style={{ margin: '6px 0 0' }}>No marks yet.</p>}
            </details>
          </li>
        ))}
        {!rows.length && <li className="faint small" style={{ padding: 14 }}>No one matches.</li>}
      </ul>
      <div className="panel public-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="table public-table">
          <thead>
            <tr>
              <th>{data.showNames ? 'Name' : 'ID'}</th>
              {shown.map((c) => <th key={c.id} className="num">{c.name}<div className="faint xs">/{c.max}</div></th>)}
              <th className="num">Total<div className="faint xs">/{data.targetTotal}</div></th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className={data.showNames ? '' : 'mono'}>{label(r)}{data.showNames && r.nameKm && r.nameLatin && <div className="faint xs">{r.nameKm}</div>}</td>
                {shown.map((c) => <td key={c.id} className="num mono">{fmt(r.values[c.i] ?? null)}</td>)}
                <td className="num mono"><b>{fmt(r.total)}</b></td>
                <td>{result(r)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={shown.length + 3} className="faint small">No one matches.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="faint xs">“–” means not marked yet. This page updates by itself. Link open until {local(data.expiresAt)}.</p>
    </div>
  );
}
