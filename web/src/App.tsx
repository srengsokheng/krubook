import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import { I18nProvider, useI18n } from './i18n.tsx';
import { Icon, Loading, ToastProvider } from './ui.tsx';
import { SyncBadge, SyncProblems } from './SyncStatus.tsx';
import { Login } from './pages/Login.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Timetable } from './pages/Timetable.tsx';
import { Classes } from './pages/Classes.tsx';
import { ClassDetail } from './pages/ClassDetail.tsx';
import { Courses, CourseDetail } from './pages/Courses.tsx';
import { Terms, TermDetail } from './pages/Terms.tsx';
import { Students, StudentDetail } from './pages/Students.tsx';
import { Pay } from './pages/Pay.tsx';
import { Settings } from './pages/Settings.tsx';
import { PrintView } from './pages/Print.tsx';

export interface Me { id: number; name: string; email: string; role: string }

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  );
}

function Gate() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupCode, setSetupCode] = useState(false);
  const { setOverrides } = useI18n();
  useEffect(() => {
    api('/auth/me').then((r) => { setMe(r.user); setNeedsSetup(r.needsSetup); setSetupCode(r.setupCode); }).catch(() => {
      // Offline at start-up: trust the last signed-in user so cached pages and the queue work.
      try { const saved = localStorage.getItem('krubook.me'); setMe(saved ? JSON.parse(saved) : null); } catch { setMe(null); }
    });
    const out = () => setMe(null);
    window.addEventListener('krubook:signed-out', out);
    return () => window.removeEventListener('krubook:signed-out', out);
  }, []);
  useEffect(() => {
    try { if (me) localStorage.setItem('krubook.me', JSON.stringify(me)); else if (me === null) localStorage.removeItem('krubook.me'); } catch { /* ignore */ }
    if (me) api('/settings').then((s) => setOverrides(s.statusLabels ?? {})).catch(() => {});
  }, [me, setOverrides]);
  if (me === undefined) return <div className="main"><Loading /></div>;
  if (!me) return <Login needsSetup={needsSetup} setupCode={setupCode} onSignedIn={setMe} />;
  return (
    <Routes>
      <Route path="/print/*" element={<PrintView />} />
      <Route path="*" element={<Shell me={me} onSignOut={() => setMe(null)}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/timetable" element={<Timetable />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/classes/:id/*" element={<ClassDetail />} />
          <Route path="/courses" element={<Courses />} />
          <Route path="/courses/:id" element={<CourseDetail />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/terms/:id" element={<TermDetail />} />
          <Route path="/students" element={<Students />} />
          <Route path="/students/:id" element={<StudentDetail />} />
          <Route path="/pay" element={<Pay />} />
          <Route path="/settings" element={<Settings me={me} />} />
          <Route path="*" element={<div className="page"><h1>Page not found</h1><NavLink to="/">Back to the dashboard</NavLink></div>} />
        </Routes>
      </Shell>} />
    </Routes>
  );
}

const NAV: Array<[string, string, string]> = [
  ['/', 'Dashboard', 'home'],
  ['/timetable', 'Timetable', 'calendar'],
  ['/classes', 'Classes', 'layers'],
  ['/students', 'Students', 'users'],
  ['/courses', 'Courses', 'book'],
  ['/terms', 'Terms', 'term'],
  ['/pay', 'Pay', 'coins'],
  ['/settings', 'Settings', 'gear'],
];

function Shell({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api' });
    onSignOut();
    nav('/');
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">Kru<b>Book</b></span><span className="brand-km">សៀវភៅគ្រូ</span></div>
        <nav className="nav">
          <div className="nav-group">
            {NAV.slice(0, 4).map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{t(label)}</NavLink>)}
          </div>
          <div className="nav-group">
            {NAV.slice(4).map(([to, label, icon]) => <NavLink key={to} to={to}><Icon name={icon} />{t(label)}</NavLink>)}
          </div>
        </nav>
        <div className="sidebar-foot">
          <SyncBadge />
          <div className="seg" role="group" aria-label={t('Language')}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
            <button className={lang === 'km' ? 'on' : ''} onClick={() => setLang('km')}>ខ្មែរ</button>
          </div>
          <div className="faint xs">{me.name} · {me.email}</div>
          <button className="btn sm" onClick={signOut}>{t('Sign out')}</button>
        </div>
      </aside>
      <main className="main">
        <SyncProblems />
        {children}
      </main>
      <nav className="bottom-nav" aria-label="Main">
        {[NAV[0], NAV[1], NAV[2], NAV[3], NAV[7]].map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{t(label)}</NavLink>)}
      </nav>
    </div>
  );
}
