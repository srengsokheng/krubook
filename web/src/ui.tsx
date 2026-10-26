import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate } from '../../shared/dates.ts';
import { useI18n } from './i18n.tsx';

// ---- Icons: simple strokes drawn for this app ----------------------------------------------
const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.85M15.5 3.15a3.5 3.5 0 0 1 0 6.7',
  book: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM18 17H7a3 3 0 0 0-3 3',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5',
  term: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3',
  coins: 'M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 4v6c0 1.7 3.6 3 8 3s8-1.3 8-3V4M4 10v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5 10 17 19 7',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  printer: 'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 6l6 6-6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
};

export function Icon({ name, title }: { name: keyof typeof paths | string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name] ?? paths.info} />
    </svg>
  );
}

// ---- Small pieces ---------------------------------------------------------------------------

export function Pill({ tone, children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'ink'; children: ReactNode; title?: string }) {
  return <span className={`pill ${tone ?? ''}`} title={title}>{children}</span>;
}

const PROGRESS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'accent' | undefined> = { ahead: 'accent', on_schedule: 'ok', behind: 'bad', not_started: undefined };
export function ProgressPill({ status, reason }: { status: string; reason?: string }) {
  const { t } = useI18n();
  return <Pill tone={PROGRESS_TONE[status]} title={reason}>{t(status)}</Pill>;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'accent' | undefined> = { completed: 'ok', planned: undefined, cancelled: 'bad', moved: 'warn', skipped: 'warn' };
export function SessionStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Pill tone={STATUS_TONE[status]}>{t(status)}</Pill>;
}

export function Kind({ kind }: { kind: string }) {
  const { t } = useI18n();
  const label = kind === 'lecture' ? t('Lecture') : kind === 'practice' ? t('Practice') : t('Exam');
  return <span className={`kind ${kind}`}>{label}</span>;
}

const MAT_TONE: Record<string, 'ok' | 'warn' | 'bad'> = { ready: 'ok', in_progress: 'warn', not_started: 'bad' };
export const MATERIAL_LABEL: Record<string, string> = { ready: 'Ready', in_progress: 'In progress', not_started: 'Not started' };
export function MaterialStatus({ status }: { status: string }) {
  return <Pill tone={MAT_TONE[status]}>{MATERIAL_LABEL[status]}</Pill>;
}

export function D({ date, year }: { date: string; year?: boolean }) {
  const { lang } = useI18n();
  return <time dateTime={date}>{formatDate(date, lang, year)}</time>;
}

/** A pay month with the teaching dates it covers: "November 2026 · 16 Oct – 15 Nov". */
export function PayMonth({ month, from, to }: { month: string; from: string; to: string }) {
  const { lang } = useI18n();
  const loc = lang === 'km' ? 'km-KH' : 'en-GB';
  const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (d: string) => lang === 'km' ? new Date(`${d}T00:00:00Z`).toLocaleDateString(loc, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : `${+d.slice(8, 10)} ${SHORT[+d.slice(5, 7) - 1]}`;
  const name = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return <span><span style={{ fontFamily: 'var(--font-body)', fontWeight: 600 }}>{name}</span><div className="faint xs">{day(from)} – {day(to)}</div></span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div className="small">{children}</div>}
      {action}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: { message: string } | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      <Icon name="alert" />
      <div className="row between" style={{ flex: 1 }}>
        <span>{error.message}</span>
        {retry && <button className="btn sm" onClick={retry}>Try again</button>}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  return <div className={`notice ${tone}`}><Icon name={tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert'} /><div style={{ flex: 1, minWidth: 0 }}>{children}</div></div>;
}

export function Dialog({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.dialog-x)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" ref={ref}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="btn ghost sm dialog-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field">{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

// ---- Toasts ------------------------------------------------------------------------------------
type Toast = { id: number; text: string; tone?: 'bad' };
const ToastCtx = createContext<(text: string, tone?: 'bad') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: 'bad') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, tone }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.tone ?? ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Runs an async action with a busy flag and shows its error as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) toast(success);
      return out;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

/** In-page confirmation, used for anything destructive or schedule-changing. */
export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button></>}>
      <div className="muted">{body}</div>
    </Dialog>
  );
}

/** "1 past session has" / "3 past sessions have". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const money = (n: number | null | undefined, currency = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
export const fmt = (n: number | null | undefined, digits = 2) => (n == null ? '—' : String(Math.round(n * 10 ** digits) / 10 ** digits));

// ---- Paging, menus, tabs ----------------------------------------------------------------------

export interface PageMeta { total: number; page: number; pageSize: number; pages: number }

/** Page navigation for server-paged lists. */
export function Pager({ meta, onPage, onSize, noun = 'results' }: { meta: PageMeta; onPage: (p: number) => void; onSize?: (s: number) => void; noun?: string }) {
  if (!meta.total) return null;
  const first = (meta.page - 1) * meta.pageSize + 1, last = Math.min(meta.total, meta.page * meta.pageSize);
  return (
    <div className="pager no-print">
      <span className="muted small"><b className="mono">{first}–{last}</b> of <b className="mono">{meta.total}</b> {noun}</span>
      <div className="row" style={{ gap: 6 }}>
        {onSize && (
          <select aria-label="Rows per page" value={meta.pageSize} onChange={(e) => onSize(+e.target.value)} style={{ width: 'auto', minHeight: 30, padding: '2px 6px' }}>
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        )}
        <button className="btn sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label="Previous page"><Icon name="left" /></button>
        <span className="mono small">{meta.page} / {meta.pages}</span>
        <button className="btn sm" disabled={meta.page >= meta.pages} onClick={() => onPage(meta.page + 1)} aria-label="Next page"><Icon name="right" /></button>
      </div>
    </div>
  );
}

/** A small dropdown for secondary actions, so toolbars show only the main action. */
export function Menu({ label = 'More', items }: { label?: ReactNode; items: Array<{ label: ReactNode; onSelect?: () => void; href?: string; danger?: boolean; hidden?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}<Icon name="down" /></button>
      {open && (
        <div className="menu-list" role="menu">
          {items.filter((i) => !i.hidden).map((i, k) => i.href
            ? <a key={k} role="menuitem" href={i.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>{i.label}</a>
            : <button key={k} role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onSelect?.(); }}>{i.label}</button>)}
        </div>
      )}
    </div>
  );
}

/** In-page tabs that keep their choice in the URL hash so reloads return to the same tab. */
export function useTab<T extends string>(tabs: readonly T[], fallback: T): [T, (t: T) => void] {
  const read = () => { const h = window.location.hash.slice(1) as T; return tabs.includes(h) ? h : fallback; };
  const [tab, setTab] = useState<T>(read);
  const set = (t: T) => { setTab(t); history.replaceState(null, '', `#${t}`); };
  return [tab, set];
}

export function TabBar<T extends string>({ tabs, value, onChange, labels }: { tabs: readonly T[]; value: T; onChange: (t: T) => void; labels: Record<T, ReactNode> }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <a key={t} role="tab" href={`#${t}`} aria-selected={value === t} className={value === t ? 'active' : ''} onClick={(e) => { e.preventDefault(); onChange(t); }}>{labels[t]}</a>)}
    </div>
  );
}

/** Debounced value for search boxes. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
