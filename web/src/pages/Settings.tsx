import { useEffect, useState } from 'react';
import { api, download, useApi } from '../api.ts';
import { useI18n, type Lang } from '../i18n.tsx';
import { Confirm, D, Empty, ErrorNote, Field, Icon, Loading, Notice, Pager, Pill, TabBar, useAction, useTab, useToast } from '../ui.tsx';
import { HolidayCheck } from './Terms.tsx';
import { diffDays } from '../../../shared/dates.ts';
import { usePref, type Theme } from '../prefs.ts';
import type { Me } from '../App.tsx';

const STATUS_KEYS = ['planned', 'completed', 'cancelled', 'skipped', 'moved', 'ahead', 'on_schedule', 'behind', 'not_started'];

const TABS = ['general', 'holidays', 'reminders', 'backup', 'activity'] as const;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function Settings({ me }: { me: Me }) {
  const { t, lang, setLang, setOverrides } = useI18n();
  const [tab, setTab] = useTab(TABS, 'general');
  const toast = useToast();
  const { data: s, error, reload } = useApi<any>('/settings');
  const { data: holidays, reload: reloadHol } = useApi<any[]>('/holidays');
  const { data: preview, reload: reloadPreview } = useApi<any>('/notifications/preview');
  const [f, setF] = useState<any>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [hol, setHol] = useState({ date: '', endDate: '', name: '', nameKm: '' });
  const [delHol, setDelHol] = useState<any>(null);
  const [restore, setRestore] = useState<{ file: any; counts: Record<string, number> } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const { busy, run } = useAction();
  const [theme, setTheme] = usePref<Theme>('view.theme', 'auto');
  useEffect(() => { if (s) { setF({ timezone: s.timezone, payPeriodStart: s.payPeriodStart, notifyEnabled: s.notifyEnabled, notifyCheckin: s.notifyCheckin, autoRecordTaught: s.autoRecordTaught, notifyTime: s.notifyTime, telegramChat: s.telegramChat, telegramToken: '' }); setLabels(s.statusLabels ?? {}); } }, [s]);
  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (!s || !f) return <div className="page"><Loading /></div>;

  const pickBackup = async (file: File) => {
    const json = JSON.parse(await file.text());
    const r = await run(() => api('/restore?dryRun=1', { body: json }));
    if (r) setRestore({ file: json, counts: r.counts });
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>{t('Settings')}</h1></div></div>
      <TabBar tabs={TABS} value={tab} onChange={setTab} labels={{ general: 'General', holidays: t('Holidays'), reminders: 'Reminders', backup: t('Backup'), activity: 'Activity' }} />
      {tab === 'activity' && <Activity />}
      <div className={tab === 'general' ? 'grid two' : 'stack'}>
        {tab === 'general' && (
        <section className="panel">
          <div className="panel-head"><h2>Language, time and pay</h2></div>
          <div className="panel-body stack">
            <Field label={t('Language')}>
              <div className="seg">{(['en', 'km'] as Lang[]).map((l) => <button key={l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>{l === 'en' ? 'English' : 'ខ្មែរ'}</button>)}</div>
            </Field>
            <p className="faint xs">The Khmer interface covers navigation, headings, statuses and common actions; longer help text is still in English.</p>
            <Field label="Theme" hint="Auto follows your device's light or dark setting.">
              <div className="seg" role="group" aria-label="Theme setting">{(['auto', 'light', 'dark'] as Theme[]).map((x) => <button key={x} className={theme === x ? 'on' : ''} aria-pressed={theme === x} onClick={() => setTheme(x)}>{x === 'auto' ? 'Auto' : x === 'light' ? 'Light' : 'Dark'}</button>)}</div>
            </Field>
            <Field label="Time zone" hint={`“Today” is ${s.today} in this zone. Cambodia does not use daylight saving time.`}><input id="st-tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
            <Field label="Pay period" hint={+f.payPeriodStart === 1 ? 'Each calendar month is paid on its own.' : `Teaching from the ${ordinal(+f.payPeriodStart)} of one month to the ${ordinal(+f.payPeriodStart - 1)} of the next is paid as the later month (e.g. ${f.payPeriodStart} Aug – ${+f.payPeriodStart - 1} Sep is September pay).`}>
              <select id="st-pay" value={f.payPeriodStart} onChange={(e) => setF({ ...f, payPeriodStart: +e.target.value })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'Calendar month (1st – end of month)' : `${ordinal(n)} of last month – ${ordinal(n - 1)} of this month`}</option>)}
              </select>
            </Field>
            <label className="check"><input type="checkbox" checked={f.autoRecordTaught} onChange={(e) => setF({ ...f, autoRecordTaught: e.target.checked })} /> Record a class as taught when it ends, if I checked in and took the roll call</label>
            <p className="faint xs">It uses the planned lesson and the full class length. Classes without both still wait on the Review page.</p>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(() => api('/settings', { method: 'PUT', body: { timezone: f.timezone, payPeriodStart: f.payPeriodStart, autoRecordTaught: f.autoRecordTaught } }), 'Saved').then(reload)}>Save</button>
          </div>
        </section>
        )}

        {tab === 'general' && <AccountPanel me={me} />}

        {tab === 'general' && <TokensPanel />}

        {tab === 'general' && (
        <section className="panel">
          <div className="panel-head"><h2>Status names</h2></div>
          <div className="panel-body stack">
            <p className="faint xs">Rename how statuses appear. Leave a box empty to use the standard wording.</p>
            <div className="form-grid">
              {STATUS_KEYS.map((k) => <Field key={k} label={k.replace('_', ' ')}><input value={labels[k] ?? ''} placeholder={t(k)} onChange={(e) => setLabels({ ...labels, [k]: e.target.value })} /></Field>)}
            </div>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => { const clean = Object.fromEntries(Object.entries(labels).filter(([, v]) => v.trim())); run(() => api('/settings', { method: 'PUT', body: { statusLabels: clean } }), 'Status names saved').then(() => setOverrides(clean)); }}>Save names</button>
          </div>
        </section>
        )}

        {tab === 'holidays' && (
        <section className="panel">
          <div className="panel-head"><h2>{t('Holidays')}</h2><span className="faint small">{holidays?.length ?? 0}</span></div>
          <div className="panel-body stack">
            {delHol && <Confirm title={`Remove “${delHol.name}”?`} body={`${delHol.end_date ? `All ${diffDays(delHol.end_date, delHol.date) + 1} days (${delHol.date} to ${delHol.end_date})` : delHol.date} will count as normal teaching days again. Use “Check classes against holidays” afterwards to update class plans.`} confirmLabel="Remove" danger onConfirm={() => run(() => api(`/holidays/${delHol.id}`, { method: 'DELETE' }), 'Holiday removed').then(reloadHol)} onClose={() => setDelHol(null)} />}
            <Notice tone="info">A holiday can be one day or a range (leave “To” empty for one day). Lunar holidays move every year. Entries marked “estimate” need checking against the government’s official list; edit the date if needed. “Verified” dates match the published sub-decree (hover for the source).</Notice>
            <div className="row">
              <select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 100 }}>{[...new Set((holidays ?? []).map((h) => h.date.slice(0, 4)))].map((y) => <option key={y}>{y}</option>)}</select>
              <HolidayCheck />
            </div>
            <div className="table-wrap panel" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="table mobile-cards">
                <thead><tr><th>From</th><th>To</th><th className="num">Days</th><th>Holiday</th><th>Status</th><th /></tr></thead>
                <tbody>{(holidays ?? []).filter((h) => h.date.startsWith(year)).map((h) => (
                  <tr key={h.id}>
                    <td data-label="From" style={{ width: 150 }}><input type="date" aria-label={`Start of ${h.name}`} defaultValue={h.date} onBlur={(e) => e.target.value && e.target.value !== h.date && run(() => api(`/holidays/${h.id}`, { method: 'PUT', body: { date: e.target.value } }), 'Holiday updated').then(reloadHol)} /></td>
                    <td data-label="To" style={{ width: 150 }}><input type="date" aria-label={`End of ${h.name}`} defaultValue={h.end_date ?? ''} min={h.date} onBlur={(e) => e.target.value !== (h.end_date ?? '') && run(() => api(`/holidays/${h.id}`, { method: 'PUT', body: { endDate: e.target.value || null } }), e.target.value ? 'Holiday updated' : 'Now a single day').then(reloadHol)} /></td>
                    <td data-label="Days" className="num mono small">{h.end_date ? diffDays(h.end_date, h.date) + 1 : 1}</td>
                    <td data-label="Holiday" className="small"><span>{h.name}{h.name_km && <div className="faint xs">{h.name_km}</div>}{h.end_date && (() => { const inside = (holidays ?? []).filter((o) => o.id !== h.id && (o.term_id ?? 0) === (h.term_id ?? 0) && o.date >= h.date && o.date <= h.end_date); return inside.length ? <div className="faint xs">Includes {inside.map((o) => o.name).join(', ')}</div> : null; })()}{h.term_name && <div className="faint xs">only {h.term_name}</div>}</span></td>
                    <td data-label="Status">{h.approx ? <Pill tone="warn" title="Estimated date; confirm against the official list">estimate</Pill> : h.verified_note ? <Pill tone="ok" title={h.verified_note}>verified</Pill> : h.source === 'national' ? <Pill>national</Pill> : <Pill tone="accent">yours</Pill>}</td>
                    <td data-label=""><button className="btn sm ghost" aria-label={`Remove ${h.name}`} onClick={() => setDelHol(h)}><Icon name="trash" /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="form-grid">
              <Field label="From"><input id="hh-from" type="date" value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} /></Field>
              <Field label="To (optional)"><input id="hh-to" type="date" value={hol.endDate} onChange={(e) => setHol({ ...hol, endDate: e.target.value })} /></Field>
              <Field label="Name"><input id="hh-name" value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} /></Field>
              <Field label="Khmer name"><input id="hh-km" value={hol.nameKm} onChange={(e) => setHol({ ...hol, nameKm: e.target.value })} /></Field>
            </div>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !hol.date || !hol.name} onClick={() => run(() => api('/holidays', { body: { ...hol, endDate: hol.endDate || null } }), 'Holiday added. Check classes to see the impact.').then(() => { setHol({ date: '', endDate: '', name: '', nameKm: '' }); reloadHol(); })}>Add holiday</button>
          </div>
        </section>
        )}

        {tab === 'reminders' && (
        <section className="panel">
          <div className="panel-head"><h2>Reminders</h2></div>
          <div className="panel-body stack">
            {me.featuresOff?.includes('reminders') && <Notice tone="warn">Telegram reminders are not included in your account. Ask the administrator.</Notice>}
            <p className="faint xs">Reminders go to Telegram once a day after the time you choose: tomorrow’s classes, materials that are not ready, and labs or exams in the next week. The check-in reminder comes before each class instead. Each reminder is sent once. Email is not supported yet.</p>
            <label className="check"><input type="checkbox" checked={f.notifyEnabled} onChange={(e) => setF({ ...f, notifyEnabled: e.target.checked })} /> Send reminders</label>
            <label className="check"><input type="checkbox" checked={f.notifyCheckin} disabled={!f.notifyEnabled} onChange={(e) => setF({ ...f, notifyCheckin: e.target.checked })} /> Check-in reminder about 10 minutes before each class, with a one-tap check-in link</label>
            <div className="form-grid">
              <Field label="Send after"><input id="n-time" type="time" value={f.notifyTime} onChange={(e) => setF({ ...f, notifyTime: e.target.value })} /></Field>
              <Field label="Telegram chat ID"><input id="n-chat" value={f.telegramChat} onChange={(e) => setF({ ...f, telegramChat: e.target.value })} /></Field>
            </div>
            <Field label="Telegram bot token" hint={s.hasTelegramToken ? 'A token is saved. Enter a new one to replace it.' : 'Create a bot with @BotFather and paste its token.'}><input id="n-token" type="password" autoComplete="off" value={f.telegramToken} onChange={(e) => setF({ ...f, telegramToken: e.target.value })} /></Field>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => run(() => api('/settings', { method: 'PUT', body: f }), 'Reminder settings saved').then(reload)}>Save</button>
              <button className="btn" disabled={busy} onClick={() => run(() => api('/notifications/test', { body: {} }), 'Test message sent')}>Send a test message</button>
            </div>
            {preview && (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row between"><h3>What would be sent today</h3><button className="btn sm ghost" onClick={reloadPreview}>Refresh</button></div>
                {preview.reminders.length ? preview.reminders.map((r: any) => <pre key={r.key} className="panel small" style={{ margin: 0, padding: 10, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-body)' }}>{r.text}</pre>) : <p className="faint small">Nothing to remind about right now.</p>}
              </div>
            )}
          </div>
        </section>
        )}

        {tab === 'backup' && (
        <section className="panel">
          <div className="panel-head"><h2>{t('Backup')} and restore</h2></div>
          {me.role === 'admin' && <BackupStatus />}
          <div className="panel-body stack">
            {me.role !== 'admin' ? <Notice tone="info">Only an administrator can back up or restore the system.</Notice> : <>
              <p className="small">A backup contains every course, term, class, student, enrollment, session, teaching record, attendance mark, grade, holiday, pay record and the audit history. It also contains password hashes, so store it somewhere private.</p>
              <div className="row">
                <button className="btn primary" onClick={() => download('/backup.json').catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Download backup (.json)</button>
                <button className="btn" onClick={() => download('/backup.xlsx').catch((e) => toast(e.message, 'bad'))}><Icon name="download" />Readable copy (.xlsx)</button>
              </div>
              <hr className="divider" />
              <h3>Restore</h3>
              <p className="faint xs">The file is checked first: its checksum, every table count, and every link between records are verified in a separate copy. Your current data is only replaced after you confirm, and the old database file is kept next to the new one.</p>
              <input type="file" accept=".json,application/json" aria-label="Backup file" onChange={(e) => e.target.files?.[0] && pickBackup(e.target.files[0]).catch((err) => toast(`That file could not be read: ${err.message}`, 'bad'))} />
              {restore && (
                <Notice tone="ok">
                  <div className="stack" style={{ gap: 6 }}>
                    <b>The backup from <D date={restore.file.exportedAt.slice(0, 10)} year /> is valid.</b>
                    <span className="small mono">{Object.entries(restore.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')}</span>
                    <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmRestore(true)}>Replace current data with this backup</button>
                  </div>
                </Notice>
              )}
            </>}
          </div>
        </section>
        )}
      </div>
      {confirmRestore && restore && <Confirm danger title="Replace all current data?" confirmLabel="Restore backup" body="Everything in KruBook is replaced by the backup. You will need to sign in again. The previous database file is kept on the server." onClose={() => setConfirmRestore(false)} onConfirm={() => run(() => api('/restore', { body: restore.file }), 'Backup restored').then((r) => { if (r) window.location.href = '/'; })} />}
    </div>
  );
}

/** Who changed what, newest first (grades, attendance, schedules, enrollments, pay). */
function Activity() {
  const [page, setPage] = useState(1);
  const [size, setSize] = usePref<number>('pageSize.activity', 10);
  const [entity, setEntity] = useState('');
  const { data, error, reload } = useApi<any>(`/audit?page=${page}&pageSize=${size}${entity ? `&entity=${entity}` : ''}`);
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Activity</h2>
        <select aria-label="Filter activity" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} style={{ width: 180 }}>
          <option value="">Everything</option>
          {['score', 'attendance', 'session', 'teaching_record', 'enrollment', 'grade_config', 'pay_statement', 'rate', 'pay_adjustment', 'student', 'class', 'course', 'term'].map((e) => <option key={e} value={e}>{e.replace('_', ' ')}</option>)}
        </select>
      </div>
      {data.total ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When (UTC)</th><th>What</th><th>Action</th><th>By</th></tr></thead>
              <tbody>{data.items.map((a: any) => <tr key={a.id}><td className="mono small">{a.at}</td><td>{a.entity.replace('_', ' ')} <span className="faint mono">#{a.entity_id}</span></td><td>{a.action}</td><td className="small">{a.user_name ?? '—'}</td></tr>)}</tbody>
            </table>
          </div>
          <Pager meta={data} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} noun="changes" />
        </>
      ) : <Empty title="No changes recorded yet" />}
    </section>
  );
}

function BackupStatus() {
  const { data } = useApi<any>('/backup/status');
  if (!data) return null;
  const line = (label: string, st: any, hint: string) => (
    <div className="row between">
      <span className="small">{label}</span>
      {!st ? <span className="faint xs">{hint}</span> : st.ok ? <Pill tone="ok" title={st.file ?? ''}>ok · {String(st.finishedAt ?? '').replace('T', ' ').slice(0, 16)} UTC</Pill> : <Pill tone="bad" title={st.error ?? ''}>failed · {String(st.finishedAt ?? '').replace('T', ' ').slice(0, 16)}</Pill>}
    </div>
  );
  return (
    <div className="panel-body stack" style={{ gap: 6, borderBottom: '1px solid var(--rule)' }}>
      {line('Nightly copy on this server', data.local, 'no record yet')}
      {line('Off-site copy', data.offsite, 'not configured')}
    </div>
  );
}

type ApiToken = { id: number; name: string; ending: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null; active: boolean };

/**
 * Access tokens let a helper (a script, an assistant) use KruBook as you without your password.
 * A token is shown once; it cannot change your password, make tokens, manage accounts or restore.
 */
function TokensPanel() {
  const { data, reload } = useApi<ApiToken[]>('/account/tokens');
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const [revoke, setRevoke] = useState<ApiToken | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const create = () => run(() => api<ApiToken & { token: string }>('/account/tokens', { body: { name, days: Number(days) } })).then((r) => {
    if (r) { setShown({ name: r.name, token: r.token }); setName(''); reload(); }
  });
  const active = (data ?? []).filter((t) => t.active);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Access tokens</h2><span className="faint small">{active.length} active</span></div>
      <div className="panel-body stack">
        <p className="faint xs" style={{ margin: 0 }}>A token lets a helper, such as an AI assistant, work in KruBook as you without your password. It cannot change your password, create tokens, manage accounts or restore backups. Give it only to something you trust, and revoke it when the job is done.</p>
        {shown && (
          <Notice tone="ok">
            <div className="stack" style={{ gap: 6 }}>
              <b>Copy “{shown.name}” now — it is not shown again.</b>
              <code className="mono small" style={{ wordBreak: 'break-all', userSelect: 'all' }} aria-label="New access token">{shown.token}</code>
              <div className="row">
                <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(shown.token).then(() => toast('Copied')); }}>Copy</button>
                <button className="btn sm ghost" onClick={() => setShown(null)}>Done</button>
              </div>
            </div>
          </Notice>
        )}
        <div className="form-grid">
          <Field label="Name" hint="What it is for, e.g. “Claude import”."><input id="tok-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Lasts">
            <select id="tok-days" value={days} onChange={(e) => setDays(e.target.value)}>
              {[['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy || !name.trim()} onClick={() => void create()}>Create token</button>
        {data && data.length > 0 && (
          <ul className="ledger" style={{ margin: '0 -18px' }}>
            {data.map((t) => (
              <li key={t.id} className={t.active ? '' : 'is-dim'}>
                <span className="grow small"><b>{t.name}</b> <span className="mono faint">…{t.ending}</span>
                  <div className="faint xs">{t.revokedAt ? `revoked ${t.revokedAt.slice(0, 10)}` : t.active ? `expires ${t.expiresAt.slice(0, 10)}` : `expired ${t.expiresAt.slice(0, 10)}`} · {t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16)}` : 'never used'}</div>
                </span>
                {t.active && <button className="btn sm danger" onClick={() => setRevoke(t)}>Revoke</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {revoke && <Confirm title={`Revoke “${revoke.name}”?`} body="Anything using this token stops working at once." confirmLabel="Revoke" danger onConfirm={() => run(() => api(`/account/tokens/${revoke.id}`, { method: 'DELETE' }), 'Token revoked').then(reload)} onClose={() => setRevoke(null)} />}
    </section>
  );
}

function AccountPanel({ me }: { me: Me }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const { busy, run } = useAction();
  const toast = useToast();
  const save = () => {
    if (f.next !== f.again) { toast('The two new passwords do not match.', 'bad'); return; }
    void run(() => api('/account/password', { body: { current: f.current, next: f.next } }), 'Password changed. Other devices are signed out.').then((r) => { if (r) setF({ current: '', next: '', again: '' }); });
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Your account</h2></div>
      <div className="panel-body stack">
        <dl className="kv">
          <dt>Signed in as</dt><dd>{me.name} · <span className="mono small">{me.email}</span></dd>
          <dt>Role</dt><dd>{me.role === 'admin' ? 'Administrator' : 'Teacher'}</dd>
          {me.role !== 'admin' && <><dt>Access until</dt><dd className="mono small">{me.accessUntil ?? 'no end date'}{me.expired ? ' (ended)' : ''}</dd></>}
        </dl>
        <div className="form-grid">
          <Field label="Current password"><input id="pw-current" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters."><input id="pw-next" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
          <Field label="New password again"><input id="pw-again" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !f.current || f.next.length < 8} onClick={save}>Change password</button>
      </div>
    </section>
  );
}
