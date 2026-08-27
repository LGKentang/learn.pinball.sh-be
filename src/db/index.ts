import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DB_PATH =
  process.env.PINBALL_DB ?? resolve(here, '../../data/pinball.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

/**
 * Migrations. Each is guarded so it runs once and is a no-op afterwards — enough
 * for a single-file local database; a real migration table can come with the first
 * deploy that has to preserve someone else's data.
 */
const tableExists = (table: string): boolean =>
  !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);

// "Exploration" was renamed to "Book". Runs before schema.sql's CREATE TABLE IF NOT
// EXISTS, which would otherwise silently create an empty `book` table and orphan
// whatever was in the old `exploration` one.
if (tableExists('exploration') && !tableExists('book')) {
  db.exec('ALTER TABLE exploration RENAME TO book');
  db.exec('ALTER TABLE question RENAME COLUMN exploration_id TO book_id');
  db.exec('ALTER TABLE source RENAME COLUMN exploration_id TO book_id');
  // RENAME COLUMN carries the old index along under its old name; schema.sql below
  // creates its replacement under the new name, so drop the stale one.
  db.exec('DROP INDEX IF EXISTS question_by_exploration');
}

db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));

const columns = (table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );

// understanding_before duplicated the previous revision's understanding_after on
// every row. It is derived with a window function now instead of stored.
if (columns('revision').has('understanding_before')) {
  db.exec('ALTER TABLE revision DROP COLUMN understanding_before');
}

/** SQLite has no uuid generator and we want ids stable across engines. */
export const newId = (): string => crypto.randomUUID();

export const now = (): string => new Date().toISOString();

/**
 * node:sqlite returns null-prototype objects, which structuredClone and some
 * serializers dislike. Normalise on the way out.
 */
export function rows<T>(stmt: StatementSync, ...args: SQLInputValue[]): T[] {
  return stmt.all(...args).map((r) => ({ ...r })) as T[];
}

export function row<T>(stmt: StatementSync, ...args: SQLInputValue[]): T | undefined {
  const r = stmt.get(...args);
  return r == null ? undefined : ({ ...r } as T);
}

/** Run fn inside a transaction; node:sqlite exposes no helper of its own. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
