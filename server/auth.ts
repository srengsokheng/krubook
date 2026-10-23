import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, type DB } from './db.ts';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'teacher';
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const COOKIE = 'kb_session';
const DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function createUser(db: DB, email: string, name: string, password: string, role: User['role'] = 'teacher'): number {
  if (password.length < 8) throw new AppError(422, 'Use a password of at least 8 characters.');
  return db.run('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)', email.trim(), name.trim(), hashPassword(password), role).id;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const secure = (req: Request) => (req.secure ? '; Secure' : '');

export function startSession(db: DB, req: Request, res: Response, userId: number) {
  const token = randomBytes(32).toString('base64url');
  db.run("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))", token, userId, `+${DAYS} days`);
  db.run("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')");
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}${secure(req)}`);
}

// Sign-in attempts per IP address: at most 10 failures in 15 minutes.
const failures = new Map<string, number[]>();
export function checkLoginRate(req: Request) {
  const key = req.ip ?? 'unknown', now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  failures.set(key, recent);
  if (recent.length >= 10) throw new AppError(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
  return () => recent.push(now);
}

export function endSession(db: DB, req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) db.run('DELETE FROM auth_sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(req)}`);
}

export function authenticate(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      const u = db.get<User>(
        "SELECT u.id, u.email, u.name, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')",
        token,
      );
      if (u) req.user = u;
    }
    next();
  };
}

export function requireUser(req: Request): User {
  if (!req.user) throw new AppError(401, 'Sign in to continue.');
  return req.user;
}
