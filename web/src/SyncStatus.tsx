import { useEffect, useState } from 'react';
import { dismissFailure, flush, resolveConflict, subscribe, type SyncState } from './offline.ts';
import { useI18n } from './i18n.tsx';
import { Icon } from './ui.tsx';

export function useSync() {
  const [s, setS] = useState<SyncState | null>(null);
  useEffect(() => subscribe(setS), []);
  return s;
}

export function SyncBadge() {
  const s = useSync();
  const { t } = useI18n();
  if (!s) return null;
  const cls = s.conflicts.length ? 'conflict' : !s.online ? 'offline' : s.pending ? 'pending' : '';
  const text = s.conflicts.length
    ? `${s.conflicts.length} conflict${s.conflicts.length > 1 ? 's' : ''} to resolve`
    : !s.online ? `${t('Offline')}${s.pending ? ` · ${s.pending} ${t('waiting to sync')}` : ''}`
    : s.syncing ? 'Syncing…'
    : s.pending ? `${s.pending} ${t('waiting to sync')}`
    : t('Synced');
  return (
    <button className={`sync ${cls} btn ghost sm`} style={{ justifyContent: 'flex-start', padding: 0 }} onClick={() => flush()} title="Sync now">
      <span className="dot" />{text}
    </button>
  );
}

/** Conflicts and rejected offline edits, shown above every page until resolved. */
export function SyncProblems() {
  const s = useSync();
  if (!s || (!s.conflicts.length && !s.failures.length)) return null;
  const show = (v: unknown) => (v === null || v === undefined ? 'empty' : String(v));
  return (
    <div className="page no-print" style={{ marginBottom: 18 }}>
      {s.conflicts.length > 0 && (
        <div className="notice bad" role="alert">
          <Icon name="alert" />
          <div className="stack" style={{ flex: 1, gap: 8 }}>
            <strong>These edits were made while offline, but someone changed the same cells first.</strong>
            {s.conflicts.map((c) => (
              <div key={c.op.key} className="row between">
                <span className="small">{c.op.label}: yours <b className="mono">{show(c.op.type === 'score' ? c.op.value : c.op.status)}</b>, saved <b className="mono">{show(c.server.value)}</b></span>
                <span className="row">
                  <button className="btn sm" onClick={() => resolveConflict(c.op.key, 'server')}>Keep saved</button>
                  <button className="btn sm primary" onClick={() => resolveConflict(c.op.key, 'mine')}>Use mine</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {s.failures.length > 0 && (
        <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
          <Icon name="alert" />
          <div className="stack" style={{ flex: 1, gap: 6 }}>
            <strong>Some edits could not be saved.</strong>
            {s.failures.map((f) => (
              <div key={f.op.key} className="row between">
                <span className="small">{f.op.label}: {f.message}</span>
                <button className="btn sm" onClick={() => dismissFailure(f.op.key)}>Dismiss</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
