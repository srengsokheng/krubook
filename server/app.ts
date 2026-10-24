import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from './db.ts';
import { authenticate } from './auth.ts';
import { buildRouter, type DBHolder } from './routes.ts';

export function createHolder(file: string): DBHolder {
  const holder: DBHolder = {
    db: new DB(file),
    file,
    reopen() {
      try { holder.db.close(); } catch { /* already closed */ }
      holder.db = new DB(file);
    },
  };
  return holder;
}

export function createApp(holder: DBHolder, opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy on the same machine: trust its X-Forwarded-* headers for HTTPS and client IP.
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '200mb' }));
  app.use((req, res, next) => authenticate(holder.db)(req, res, next));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', buildRouter(holder));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  // Malformed JSON or oversized bodies: answer in JSON like every other API error.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) return next();
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: status === 413 ? 'The upload is too large.' : status === 400 ? 'The request body is not valid JSON.' : 'Something went wrong on the server.' });
  });
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, setHeaders: (res, path) => { if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
  }
  return app;
}
