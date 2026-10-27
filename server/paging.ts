import { AppError } from './db.ts';

export const PAGE_SIZES = [10, 25, 50, 100];

export interface Page { page: number; pageSize: number; offset: number }

/** Reads ?page and ?pageSize; rejects values outside the allowed set instead of guessing. */
export function readPage(q: Record<string, unknown>, defaultSize = 10): Page {
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? defaultSize : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new AppError(400, 'page must be a whole number of 1 or more.');
  if (!PAGE_SIZES.includes(pageSize)) throw new AppError(400, `pageSize must be one of ${PAGE_SIZES.join(', ')}.`);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number; pages: number }

export function paged<T>(items: T[], total: number, p: Page): Paged<T> {
  return { items, total, page: p.page, pageSize: p.pageSize, pages: Math.max(1, Math.ceil(total / p.pageSize)) };
}

/** Pages an array that is already in memory (for computed rows such as pay lines). */
export function pageArray<T>(all: T[], p: Page): Paged<T> {
  return paged(all.slice(p.offset, p.offset + p.pageSize), all.length, p);
}

/** Maps a ?sort value onto an allowed SQL ORDER BY, so user input never reaches SQL directly. */
export function readSort(q: Record<string, unknown>, allowed: Record<string, string>, fallback: string): string {
  const key = String(q.sort ?? '');
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  return allowed[key] ? `${allowed[key]} ${dir}` : allowed[fallback] ?? fallback;
}
