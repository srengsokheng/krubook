// Per-account display preferences (language, rows per page, sort orders, views). They are saved on
// the server so they follow the teacher to every device, and cached here so the app opens with them
// even offline. Keys: lang, pageSize.<table>, sort.<list>, view.<page>.
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

const KEY = 'krubook.prefs';
type Prefs = Record<string, string | number>;

let prefs: Prefs = (() => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // Older versions kept the language on its own.
    const lang = localStorage.getItem('krubook.lang');
    return lang && !p.lang ? { ...p, lang } : p;
  } catch { return {}; }
})();
const listeners = new Set<() => void>();

function commit(next: Prefs) {
  prefs = next;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not cached */ }
  listeners.forEach((l) => l());
}

/** After sign-in: the account's saved preferences replace whatever this browser had. */
export async function loadPrefs() {
  try { commit(await api('/prefs')); } catch { /* offline: keep the cached copy */ }
}

/** On sign-out, so the next person on this device starts clean. */
export function clearPrefs() { commit({}); }

export function getPref<T extends string | number>(key: string, fallback: T): T {
  return (prefs[key] as T) ?? fallback;
}

export function setPref(key: string, value: string | number) {
  if (prefs[key] === value) return;
  commit({ ...prefs, [key]: value });
  api('/prefs', { method: 'PUT', body: { [key]: value } }).catch(() => { /* kept locally; saved next time */ });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function usePref<T extends string | number>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(subscribe, () => (prefs[key] as T) ?? fallback);
  return [value, (v: T) => setPref(key, v)];
}
