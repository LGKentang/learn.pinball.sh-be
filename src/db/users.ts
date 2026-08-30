/**
 * Accounts, sessions, allowlist and publishing.
 *
 * The public reads at the bottom are the only queries in the codebase that are not
 * scoped to a signed-in user, so they are deliberately kept together and every one
 * of them requires `published_at IS NOT NULL`.
 */
import { count, newId, row, rows } from './index.js';
import { env } from '../env.js';
import type { State, User } from '../types.js';

/* ----------------------------------------------------------------- accounts */

export function findUserById(id: string): Promise<User | undefined> {
  return row<User>('SELECT * FROM app_user WHERE id = $1', [id]);
}

export function findUserByGoogleSub(sub: string): Promise<User | undefined> {
  return row<User>('SELECT * FROM app_user WHERE google_sub = $1', [sub]);
}

export function findUserByEmail(email: string): Promise<User | undefined> {
  return row<User>('SELECT * FROM app_user WHERE email = lower($1)', [email]);
}

export function findUserByHandle(handle: string): Promise<User | undefined> {
  return row<User>('SELECT * FROM app_user WHERE handle = lower($1)', [handle]);
}

export function createUser(input: {
  email: string;
  google_sub?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  is_admin?: boolean;
}): Promise<User | undefined> {
  return row<User>(
    `INSERT INTO app_user (id, email, google_sub, name, avatar_url, is_admin)
     VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING *`,
    [
      newId(),
      input.email,
      input.google_sub ?? null,
      input.name ?? null,
      input.avatar_url ?? null,
      input.is_admin ?? false,
    ],
  );
}

/**
 * Bind a Google identity to an existing row and refresh the profile. This is what
 * lets the pre-OAuth data have an owner: the importer creates the account from
 * PINBALL_BOOTSTRAP_EMAIL with no google_sub, and the first real sign-in claims it.
 */
export function linkGoogleAccount(
  id: string,
  input: { google_sub: string; name?: string | null; avatar_url?: string | null },
): Promise<User | undefined> {
  return row<User>(
    `UPDATE app_user
        SET google_sub = $2,
            name = coalesce($3, name),
            avatar_url = coalesce($4, avatar_url),
            last_seen_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, input.google_sub, input.name ?? null, input.avatar_url ?? null],
  );
}

export function updateProfile(
  id: string,
  patch: { handle?: string; bio?: string | null; name?: string },
): Promise<User | undefined> {
  return row<User>(
    `UPDATE app_user
        SET handle = coalesce($2, handle),
            name = coalesce($3, name),
            bio = CASE WHEN $4 THEN $5 ELSE bio END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, patch.handle ?? null, patch.name ?? null, 'bio' in patch, patch.bio ?? null],
  );
}

export async function touchUser(id: string): Promise<void> {
  await count('UPDATE app_user SET last_seen_at = now() WHERE id = $1', [id]);
}

/* ---------------------------------------------------------------- allowlist */

/**
 * Signup is closed for now (D14). An address gets in via PINBALL_ALLOWLIST, via a
 * row in signup_allowlist, or by being the bootstrap owner. A bare `@domain.com`
 * entry admits everyone at that domain.
 */
export async function isAllowed(email: string): Promise<boolean> {
  const addr = email.toLowerCase();
  const domain = '@' + addr.split('@')[1];
  if (env.bootstrapEmail && addr === env.bootstrapEmail) return true;
  if (env.allowlist.includes(addr) || env.allowlist.includes(domain)) return true;
  const hit = await row<{ email: string }>(
    'SELECT email FROM signup_allowlist WHERE email = $1 OR email = $2',
    [addr, domain],
  );
  return !!hit;
}

export async function addToAllowlist(email: string, note: string | null): Promise<void> {
  await count(
    `INSERT INTO signup_allowlist (email, note) VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET note = excluded.note`,
    [email, note],
  );
}

export async function removeFromAllowlist(email: string): Promise<boolean> {
  return (await count('DELETE FROM signup_allowlist WHERE email = lower($1)', [email])) > 0;
}

export function listAllowlist() {
  return rows<{ email: string; note: string | null; created_at: string }>(
    'SELECT * FROM signup_allowlist ORDER BY created_at DESC',
  );
}

/* ----------------------------------------------------------------- sessions */

const SESSION_DAYS = 30;

export async function createSession(
  userId: string,
  tokenHash: string,
  userAgent: string | null,
): Promise<void> {
  await count(
    `INSERT INTO user_session (id, user_id, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [tokenHash, userId, userAgent?.slice(0, 400) ?? null, String(SESSION_DAYS)],
  );
}

/**
 * Look up and slide the expiry in one statement, so an active session never
 * expires under someone mid-session and an expired one is never returned.
 */
export function useSession(tokenHash: string): Promise<User | undefined> {
  return row<User>(
    `WITH live AS (
       UPDATE user_session
          SET last_seen_at = now(),
              expires_at = now() + ($2 || ' days')::interval
        WHERE id = $1 AND expires_at > now()
        RETURNING user_id
     )
     SELECT u.* FROM app_user u JOIN live ON live.user_id = u.id`,
    [tokenHash, String(SESSION_DAYS)],
  );
}

export async function destroySession(tokenHash: string): Promise<void> {
  await count('DELETE FROM user_session WHERE id = $1', [tokenHash]);
}

export async function purgeExpiredSessions(): Promise<number> {
  return count('DELETE FROM user_session WHERE expires_at < now()');
}

/* --------------------------------------------------------------- publishing */

/** Turn a title into a URL slug; collisions are resolved by the caller. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : 'book';
}

/** The first free slug for this user, appending -2, -3, … as needed. */
export async function freeSlug(userId: string, title: string, exceptBookId?: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (
      await rows<{ slug: string }>(
        'SELECT slug FROM book WHERE user_id = $1 AND slug IS NOT NULL AND id <> $2',
        [userId, exceptBookId ?? ''],
      )
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${newId().slice(0, 8)}`;
}

export function setPublished(
  userId: string,
  bookId: string,
  published: boolean,
  slug: string | null,
) {
  return row<{ id: string; slug: string | null; published_at: string | null }>(
    `UPDATE book
        SET slug = CASE WHEN $3 THEN $4 ELSE slug END,
            published_at = CASE WHEN $3 THEN coalesce(published_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, slug, published_at`,
    [bookId, userId, published, slug],
  );
}

/* ------------------------------------------------------------ public reads */

export interface PublicProfile {
  handle: string;
  name: string | null;
  bio: string | null;
  avatar_url: string | null;
}

export function publicProfile(handle: string): Promise<PublicProfile | undefined> {
  return row<PublicProfile>(
    `SELECT handle, name, bio, avatar_url FROM app_user WHERE handle = lower($1)`,
    [handle],
  );
}

export interface PublicBookSummary {
  slug: string;
  title: string;
  intent: string | null;
  published_at: string;
  updated_at: string;
  question_count: number;
}

export function publicBooks(handle: string): Promise<PublicBookSummary[]> {
  return rows<PublicBookSummary>(
    `SELECT b.slug, b.title, b.intent, b.published_at, b.updated_at,
            (SELECT count(*) FROM question q
              WHERE q.book_id = b.id AND q.understanding IS NOT NULL) AS question_count
       FROM book b JOIN app_user u ON u.id = b.user_id
      WHERE u.handle = lower($1)
        AND b.published_at IS NOT NULL
        AND b.archived_at IS NULL
      ORDER BY b.updated_at DESC`,
    [handle],
  );
}

export interface PublicBook {
  id: string;
  slug: string;
  title: string;
  intent: string | null;
  published_at: string;
  updated_at: string;
}

export function publicBook(handle: string, slug: string): Promise<PublicBook | undefined> {
  return row<PublicBook>(
    `SELECT b.id, b.slug, b.title, b.intent, b.published_at, b.updated_at
       FROM book b JOIN app_user u ON u.id = b.user_id
      WHERE u.handle = lower($1) AND b.slug = lower($2)
        AND b.published_at IS NOT NULL AND b.archived_at IS NULL`,
    [handle, slug],
  );
}

export interface PublicQuestion {
  id: string;
  parent_id: string | null;
  title: string;
  understanding: string | null;
  state: State;
  depth: number;
}

/**
 * The published tree. Only current answers travel (the reader's choice at build
 * time): no revision history, no review ratings, no parked rabbit holes, and no
 * questions that have never been answered — an empty question is a private to-do.
 */
export function publicTree(bookId: string): Promise<PublicQuestion[]> {
  return rows<PublicQuestion>(
    `WITH RECURSIVE tree AS (
       SELECT q.id, q.parent_id, q.title, q.understanding, q.state, 0 AS depth,
              lpad(q.position::text, 6, '0') AS path
         FROM question q
        WHERE q.book_id = $1 AND q.parent_id IS NULL AND q.parked_at IS NULL
       UNION ALL
       SELECT q.id, q.parent_id, q.title, q.understanding, q.state, t.depth + 1,
              t.path || '.' || lpad(q.position::text, 6, '0')
         FROM question q JOIN tree t ON q.parent_id = t.id
        WHERE q.parked_at IS NULL
     )
     SELECT id, parent_id, title, understanding, state, depth
       FROM tree
      WHERE understanding IS NOT NULL AND btrim(understanding) <> ''
      ORDER BY path`,
    [bookId],
  );
}
