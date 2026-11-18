import { useState } from 'react';
import { api, useApi } from './api.ts';
import { Dialog, Field, Icon, Notice, Pill, useAction, useToast } from './ui.tsx';

// Share a class's marks with its students: a link anyone can open without signing in, that ends
// by itself after the chosen time (or when the teacher stops it).

type Share = { id: number; token: string; showNames: boolean; createdAt: string; expiresAt: string; revokedAt: string | null; views: number; lastViewedAt: string | null; active: boolean };

const linkOf = (token: string) => `${window.location.origin}/s/${token}`;
const local = (utc: string) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function ShareScores({ cls, onClose }: { cls: any; onClose: () => void }) {
  const { data, reload } = useApi<Share[]>(`/classes/${cls.id}/shares`);
  const [days, setDays] = useState('1');
  const [showNames, setShowNames] = useState(true);
  const { busy, run } = useAction();
  const toast = useToast();
  const active = (data ?? []).filter((s) => s.active);
  const copy = async (token: string) => {
    try { await navigator.clipboard.writeText(linkOf(token)); toast('Link copied'); } catch { toast('Select the link and copy it', 'bad'); }
  };
  const create = () => run(() => api<Share>(`/classes/${cls.id}/shares`, { body: { days: Number(days), showNames } }), 'Link made').then((r) => { if (r) { reload(); void copy(r.token); } });

  return (
    <Dialog title={`Share marks with ${cls.code} students`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>Students open the link without signing in and see the class’s marks, updating as you enter them. Anyone with the link can see it until it ends, so keep it short.</p>
        <div className="form-grid">
          <Field label="Link works for">
            <select id="share-days" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="0.5">12 hours</option><option value="1">1 day</option><option value="2">2 days</option><option value="7">7 days</option>
            </select>
          </Field>
          <Field label="Show">
            <select id="share-names" value={showNames ? 'names' : 'ids'} onChange={(e) => setShowNames(e.target.value === 'names')}>
              <option value="names">Student ID and name</option><option value="ids">Student ID only</option>
            </select>
          </Field>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void create()}><Icon name="plus" />Make link and copy it</button>
        {active.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {active.map((s) => (
              <div key={s.id} className="panel" style={{ padding: 12 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <code className="mono small" style={{ wordBreak: 'break-all', userSelect: 'all', flex: 1, minWidth: 200 }} aria-label="Student link">{linkOf(s.token)}</code>
                  <button className="btn sm" onClick={() => void copy(s.token)}>Copy</button>
                  <a className="btn sm" href={`https://t.me/share/url?url=${encodeURIComponent(linkOf(s.token))}&text=${encodeURIComponent(`ពិន្ទុថ្នាក់ ${cls.code} · Class scores`)}`} target="_blank" rel="noreferrer">Telegram</a>
                  <a className="btn sm" href={linkOf(s.token)} target="_blank" rel="noreferrer">Open</a>
                  <button className="btn sm danger" disabled={busy} onClick={() => run(() => api(`/shares/${s.id}`, { method: 'DELETE' }), 'Link stopped').then(reload)}>Stop sharing</button>
                </div>
                <div className="faint xs" style={{ marginTop: 6 }}>
                  Ends {local(s.expiresAt)} · {s.showNames ? 'IDs and names' : 'IDs only'} · opened {s.views} time{s.views === 1 ? '' : 's'}
                </div>
              </div>
            ))}
          </div>
        ) : data ? <Notice>No open links for this class.</Notice> : null}
        {(data ?? []).some((s) => !s.active) && <span className="faint xs">Ended links: {(data ?? []).filter((s) => !s.active).length} <Pill>closed</Pill></span>}
      </div>
    </Dialog>
  );
}
