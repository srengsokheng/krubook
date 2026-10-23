import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/kantumruy-pro/400.css';
import '@fontsource/kantumruy-pro/500.css';
import '@fontsource/kantumruy-pro/600.css';
import '@fontsource/kantumruy-pro/700.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { App } from './App.tsx';
import { startSync } from './offline.ts';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
startSync();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').then(async (reg) => {
    await navigator.serviceWorker.ready;
    // Cache the bundles and fonts this page already loaded, so the next visit works offline.
    const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.startsWith(location.origin) && !u.includes('/api/'));
    (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'precache', urls });
  }).catch(() => { /* the app still works online */ });
}
