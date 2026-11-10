import { AppError, DB } from '../../db.ts';
import type { User } from '../../auth.ts';
import { claudeWriter, geminiWriter, sampleCopyWriter, type Writer } from './write.ts';

// Which AI writes lesson slides, chosen by an administrator: Claude or Google Gemini, the model,
// and an API key for each. Keys come from the server environment (ANTHROPIC_API_KEY,
// GEMINI_API_KEY) or are saved on the Accounts page; they live in app_secrets, which is never
// part of a backup, and only their last four characters are ever shown.

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)', env: 'ANTHROPIC_API_KEY', keyHint: 'console.anthropic.com → API keys', keyPattern: /^sk-ant-[\w-]{20,}$/,
    defaultModel: 'claude-haiku-5-5',
    models: [
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (cheapest)', note: 'About $0.02–$0.05 a lesson.' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Better writing, about $0.15–$0.50 a lesson.' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5 (best)', note: 'Best writing, about $0.30–$1 a lesson.' },
    ],
  },
  gemini: {
    label: 'Google Gemini', env: 'GEMINI_API_KEY', keyHint: 'aistudio.google.com → Get API key', keyPattern: /^[\w-]{30,}$/,
    defaultModel: 'gemini-3.6-flash',
    models: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'Cheap and fast; the cost shows on your Google bill.' }],
  },
} as const;
export type Provider = keyof typeof PROVIDERS;
const isProvider = (p: unknown): p is Provider => typeof p === 'string' && p in PROVIDERS;

const secret = (db: DB, name: string): string | null => db.get('SELECT value FROM app_secrets WHERE name = ?', name)?.value ?? null;
function putSecret(db: DB, u: User, name: string, value: string | null) {
  if (value === null) db.run('DELETE FROM app_secrets WHERE name = ?', name);
  else db.run(`INSERT INTO app_secrets (name, value, updated_by) VALUES (?,?,?)
               ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`, name, value, u.id);
}

function keyOf(db: DB, p: Provider): { key: string | null; source: 'env' | 'admin' | null } {
  const env = process.env[PROVIDERS[p].env];
  if (env) return { key: env, source: 'env' };
  const saved = secret(db, `${p}_api_key`);
  return saved ? { key: saved, source: 'admin' } : { key: null, source: null };
}

/** The chosen provider and model; Claude Haiku unless an administrator chose otherwise. */
export function aiChoice(db: DB): { provider: Provider; model: string } {
  const p = secret(db, 'ai_provider');
  const provider: Provider = isProvider(p) ? p : 'anthropic';
  return { provider, model: secret(db, `${provider}_model`) || PROVIDERS[provider].defaultModel };
}

const demo = () => process.env.KRUBOOK_SLIDES_WRITER === 'sample-copy';

/** What a teacher's page needs to know: can lessons be written, and by which model. */
export function aiStatus(db: DB) {
  const { provider, model } = aiChoice(db);
  const { key } = keyOf(db, provider);
  return { ready: !!key || demo(), demo: !key && demo(), provider, providerLabel: PROVIDERS[provider].label, model };
}

/** The full settings for the Accounts page (administrators only). */
export function aiSettings(db: DB, u: User) {
  if (u.role !== 'admin') throw new AppError(403, 'Only an administrator can see the AI settings.');
  const { provider, model } = aiChoice(db);
  return {
    provider, model,
    providers: (Object.keys(PROVIDERS) as Provider[]).map((p) => {
      const k = keyOf(db, p);
      return { id: p, label: PROVIDERS[p].label, keyHint: PROVIDERS[p].keyHint, env: PROVIDERS[p].env, models: PROVIDERS[p].models, defaultModel: PROVIDERS[p].defaultModel, model: secret(db, `${p}_model`) || PROVIDERS[p].defaultModel, key: { source: k.source, ending: k.key ? k.key.slice(-4) : null } };
    }),
  };
}

/** Saves the provider, its model and/or its key. `key: null` removes the saved key. */
export function saveAiSettings(db: DB, u: User, body: any) {
  if (u.role !== 'admin') throw new AppError(403, 'Only an administrator can change the AI settings.');
  const provider = body?.provider;
  if (!isProvider(provider)) throw new AppError(422, 'Choose Claude or Gemini.');
  const changes: Record<string, unknown> = { provider };
  let model: string | undefined;
  if (body.model !== undefined) {
    model = String(body.model ?? '').trim();
    if (!/^[a-z0-9][a-z0-9.\-_]{1,80}$/i.test(model)) throw new AppError(422, 'Enter a model name such as claude-haiku-5-5 or gemini-3.6-flash.');
    changes.model = model;
  }
  let key: string | null | undefined;
  if (body.key !== undefined) {
    key = body.key === null ? null : String(body.key).trim();
    if (key !== null && !PROVIDERS[provider].keyPattern.test(key)) {
      throw new AppError(422, provider === 'anthropic' ? 'That does not look like a Claude API key (it starts with sk-ant-).' : 'That does not look like a Gemini API key.');
    }
    changes.key = key === null ? 'removed' : `…${key.slice(-4)}`;
  }
  db.tx(() => {
    if (body.use !== false) putSecret(db, u, 'ai_provider', provider);
    if (model !== undefined) putSecret(db, u, `${provider}_model`, model);
    if (key !== undefined) putSecret(db, u, `${provider}_api_key`, key);
    db.audit(u.id, 'ai_settings', 0, 'update', undefined, changes);
  });
  return aiSettings(db, u);
}

let writerOverride: Writer | null = null;
/** Tests replace the writer so no real API call is made. */
export function setWriter(w: Writer | null) { writerOverride = w; }

/** The writer for the chosen provider, or a clear message when it is not set up. */
export function writerFor(db: DB): Writer {
  if (writerOverride) return writerOverride;
  const { provider, model } = aiChoice(db);
  const { key } = keyOf(db, provider);
  if (key) return provider === 'gemini' ? geminiWriter(key, model) : claudeWriter(key, model);
  if (demo()) return sampleCopyWriter;
  throw new AppError(409, `Lesson writing is not set up yet: the administrator needs to add a ${PROVIDERS[provider].label} API key (Accounts page).`, { code: 'NO_API_KEY' });
}
