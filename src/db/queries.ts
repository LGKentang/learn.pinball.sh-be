/**
 * All learning-content SQL. Every function takes the acting user's id and filters
 * on it *in the query* rather than checking ownership first and acting second —
 * a forgotten guard then returns no rows instead of someone else's book.
 *
 * Publishing, accounts and sessions live in ./users.ts.
 */
import { count, newId, now, row, rows, tx, type Tx } from './index.js';
import {
  applyRating,
  nextReviewAt,
  type Book,
  type Library,
  type Question,
  type Rating,
  type RelationKind,
  type Revision,
  type RevisionKind,
  type State,
} from '../types.js';

/* ---------------------------------------------------------------------- books */

export type BookSummary = Book & {
  question_count: number;
  open_count: number;
  library_title: string | null;
};

export function listBooks(userId: string): Promise<BookSummary[]> {
  return rows<BookSummary>(
    `SELECT b.*, l.title AS library_title,
            (SELECT count(*) FROM question q WHERE q.book_id = b.id) AS question_count,
            (SELECT count(*) FROM question q WHERE q.book_id = b.id
               AND q.state = 'unexplored' AND q.parked_at IS NULL) AS open_count
       FROM book b
       LEFT JOIN library l ON l.id = b.library_id
      WHERE b.user_id = $1 AND b.archived_at IS NULL
      ORDER BY b.updated_at DESC`,
    [userId],
  );
}

export function getBook(userId: string, id: string): Promise<Book | undefined> {
  return row<Book>('SELECT * FROM book WHERE id = $1 AND user_id = $2', [id, userId]);
}

export function createBook(
  userId: string,
  title: string,
  intent: string | null,
  libraryId: string | null = null,
): Promise<Book | undefined> {
  return row<Book>(
    `INSERT INTO book (id, user_id, title, intent, library_id)
     SELECT $1, $2, $3, $4, $5::text
      WHERE $5::text IS NULL OR EXISTS (SELECT 1 FROM library l WHERE l.id = $5::text AND l.user_id = $2)
     RETURNING *`,
    [newId(), userId, title, intent, libraryId],
  );
}

export function updateBook(
  userId: string,
  id: string,
  patch: { title?: string; intent?: string | null; library_id?: string | null },
): Promise<Book | undefined> {
  return row<Book>(
    `UPDATE book
        SET title = coalesce($3, title),
            intent = CASE WHEN $4 THEN $5 ELSE intent END,
            library_id = CASE WHEN $6 THEN $7::text ELSE library_id END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
        AND ($6 = false OR $7::text IS NULL
             OR EXISTS (SELECT 1 FROM library l WHERE l.id = $7::text AND l.user_id = $2))
      RETURNING *`,
    [
      id,
      userId,
      patch.title ?? null,
      'intent' in patch,
      patch.intent ?? null,
      'library_id' in patch,
      patch.library_id ?? null,
    ],
  );
}

export async function deleteBook(userId: string, id: string): Promise<boolean> {
  return (await count('DELETE FROM book WHERE id = $1 AND user_id = $2', [id, userId])) > 0;
}

/* ------------------------------------------------------------------- libraries */

export type LibrarySummary = Library & { book_count: number };

export function listLibraries(userId: string): Promise<LibrarySummary[]> {
  return rows<LibrarySummary>(
    `SELECT l.*, (SELECT count(*) FROM book b WHERE b.library_id = l.id) AS book_count
       FROM library l
      WHERE l.user_id = $1
      ORDER BY l.favorite DESC, l.updated_at DESC`,
    [userId],
  );
}

export function createLibrary(userId: string, title: string): Promise<Library | undefined> {
  return row<Library>(
    `INSERT INTO library (id, user_id, title) VALUES ($1,$2,$3) RETURNING *`,
    [newId(), userId, title],
  );
}

export function updateLibrary(
  userId: string,
  id: string,
  patch: { title?: string; favorite?: boolean },
): Promise<Library | undefined> {
  return row<Library>(
    `UPDATE library
        SET title = coalesce($3, title),
            favorite = CASE WHEN $4 THEN $5 ELSE favorite END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [id, userId, patch.title ?? null, 'favorite' in patch, patch.favorite ?? null],
  );
}

export async function deleteLibrary(userId: string, id: string): Promise<boolean> {
  return (await count('DELETE FROM library WHERE id = $1 AND user_id = $2', [id, userId])) > 0;
}

/* ------------------------------------------------------------------- questions */

export function getQuestion(userId: string, id: string): Promise<Question | undefined> {
  return row<Question>(
    `SELECT q.* FROM question q JOIN book b ON b.id = q.book_id
      WHERE q.id = $1 AND b.user_id = $2`,
    [id, userId],
  );
}

/** Depth-ordered tree for one book. */
export function bookTree(
  userId: string,
  bookId: string,
): Promise<(Question & { depth: number })[]> {
  return rows(
    `WITH RECURSIVE tree AS (
       SELECT q.*, 0 AS depth, lpad(q.position::text, 6, '0') AS path
         FROM question q JOIN book b ON b.id = q.book_id
        WHERE q.book_id = $1 AND b.user_id = $2 AND q.parent_id IS NULL
       UNION ALL
       SELECT q.*, t.depth + 1, t.path || '.' || lpad(q.position::text, 6, '0')
         FROM question q JOIN tree t ON q.parent_id = t.id
     )
     SELECT * FROM tree ORDER BY path`,
    [bookId, userId],
  );
}

/** Root-first chain of ancestors, so the learner never loses the way back. */
export function ancestors(
  userId: string,
  id: string,
): Promise<Pick<Question, 'id' | 'title' | 'state'>[]> {
  return rows(
    `WITH RECURSIVE up AS (
       SELECT q.id, q.parent_id, q.title, q.state, 0 AS height
         FROM question q JOIN book b ON b.id = q.book_id
        WHERE q.id = $1 AND b.user_id = $2
       UNION ALL
       SELECT q.id, q.parent_id, q.title, q.state, u.height + 1
         FROM question q JOIN up u ON u.parent_id = q.id
     )
     SELECT id, title, state FROM up WHERE id <> $1 ORDER BY height DESC`,
    [id, userId],
  );
}

export function children(userId: string, id: string): Promise<Question[]> {
  return rows<Question>(
    `SELECT q.* FROM question q JOIN book b ON b.id = q.book_id
      WHERE q.parent_id = $1 AND b.user_id = $2
      ORDER BY q.position, q.created_at`,
    [id, userId],
  );
}

export function createQuestion(
  userId: string,
  input: { book_id: string; parent_id?: string | null; title: string },
): Promise<Question | undefined> {
  const parent = input.parent_id ?? null;
  return tx(async (t) => {
    // FOR UPDATE also serialises the position calculation below against a
    // concurrent insert into the same book.
    const book = await t.row<{ id: string }>(
      'SELECT id FROM book WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [input.book_id, userId],
    );
    if (!book) return undefined;

    if (parent) {
      const ok = await t.row<{ id: string }>(
        'SELECT id FROM question WHERE id = $1 AND book_id = $2',
        [parent, input.book_id],
      );
      if (!ok) return undefined;
    }

    const next = await t.row<{ n: number }>(
      `SELECT coalesce(max(position), -1) + 1 AS n FROM question
        WHERE book_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
      [input.book_id, parent],
    );

    const created = await t.row<Question>(
      `INSERT INTO question (id, book_id, parent_id, title, position)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId(), input.book_id, parent, input.title, next?.n ?? 0],
    );
    // Asking a subquestion is itself evidence the parent is being worked on.
    if (parent) {
      await t.count(
        `UPDATE question SET state = 'exploring', updated_at = now()
          WHERE id = $1 AND state = 'unexplored'`,
        [parent],
      );
    }
    await t.count('UPDATE book SET updated_at = now() WHERE id = $1', [input.book_id]);
    return created;
  });
}

/**
 * Invariant 1: understanding never changes without a revision row in the same
 * transaction. The old text is the learning artifact, not garbage.
 */
export function reviseUnderstanding(
  userId: string,
  input: {
    question_id: string;
    understanding: string;
    kind?: RevisionKind;
    note?: string | null;
    triggered_by_question_id?: string | null;
  },
): Promise<{ question: Question; revision: Revision } | undefined> {
  return tx(async (t) => {
    const q = await t.row<Question>(
      `SELECT q.* FROM question q JOIN book b ON b.id = q.book_id
        WHERE q.id = $1 AND b.user_id = $2 FOR UPDATE OF q`,
      [input.question_id, userId],
    );
    if (!q) return undefined;

    const kind: RevisionKind =
      input.kind ?? (q.understanding == null || q.understanding === '' ? 'initial' : 'refinement');

    // A trigger pointing at someone else's question would leak a title on read.
    const trigger = input.triggered_by_question_id ?? null;
    const triggerOk = trigger
      ? await t.row<{ id: string }>(
          `SELECT q.id FROM question q JOIN book b ON b.id = q.book_id
            WHERE q.id = $1 AND b.user_id = $2`,
          [trigger, userId],
        )
      : undefined;

    const revision = await t.row<Revision>(
      `INSERT INTO revision (id, question_id, understanding_after, kind, note,
                             triggered_by_question_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId(), q.id, input.understanding, kind, input.note ?? null, triggerOk ? trigger : null],
    );
    const state: State = q.state === 'unexplored' ? 'exploring' : q.state;
    const question = await t.row<Question>(
      `UPDATE question SET understanding = $2, state = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [q.id, input.understanding, state],
    );
    await t.count('UPDATE book SET updated_at = now() WHERE id = $1', [q.book_id]);
    return { question: question!, revision: revision! };
  });
}

export function setState(
  userId: string,
  id: string,
  state: State,
): Promise<Question | undefined> {
  // D4: entering the rotation at all is what makes a question drillable, so a
  // question that has never been scheduled gets its first due date here.
  return row<Question>(
    `UPDATE question q
        SET state = $3,
            next_review_at = coalesce(q.next_review_at,
                                      CASE WHEN $3 = 'unexplored' THEN NULL ELSE $4::timestamptz END),
            updated_at = now()
      WHERE q.id = $1
        AND EXISTS (SELECT 1 FROM book b WHERE b.id = q.book_id AND b.user_id = $2)
      RETURNING q.*`,
    [id, userId, state, nextReviewAt('knew_it', new Date())],
  );
}

/** D2: parking is orthogonal to understanding, so the state is left untouched. */
export function setParked(
  userId: string,
  id: string,
  parked: boolean,
  reason?: string | null,
): Promise<Question | undefined> {
  return row<Question>(
    `UPDATE question q
        SET parked_at = CASE WHEN $3 THEN now() ELSE NULL END,
            park_reason = CASE WHEN $3 THEN $4 ELSE NULL END,
            updated_at = now()
      WHERE q.id = $1
        AND EXISTS (SELECT 1 FROM book b WHERE b.id = q.book_id AND b.user_id = $2)
      RETURNING q.*`,
    [id, userId, parked, parked ? (reason ?? null) : null],
  );
}

export function renameQuestion(
  userId: string,
  id: string,
  title: string,
): Promise<Question | undefined> {
  return row<Question>(
    `UPDATE question q SET title = $3, updated_at = now()
      WHERE q.id = $1
        AND EXISTS (SELECT 1 FROM book b WHERE b.id = q.book_id AND b.user_id = $2)
      RETURNING q.*`,
    [id, userId, title],
  );
}

export async function deleteQuestion(userId: string, id: string): Promise<boolean> {
  return (
    (await count(
      `DELETE FROM question q
        WHERE q.id = $1
          AND EXISTS (SELECT 1 FROM book b WHERE b.id = q.book_id AND b.user_id = $2)`,
      [id, userId],
    )) > 0
  );
}

/**
 * The previous answer is the previous row's — derived here rather than stored,
 * so the two can never disagree and each answer is kept exactly once.
 */
export function revisions(
  userId: string,
  questionId: string,
): Promise<(Revision & { triggered_by_title: string | null })[]> {
  return rows(
    `WITH ordered AS (
       SELECT r.*,
              lag(r.understanding_after) OVER (
                PARTITION BY r.question_id ORDER BY r.created_at, r.id
              ) AS understanding_before
         FROM revision r
         JOIN question q ON q.id = r.question_id
         JOIN book b ON b.id = q.book_id
        WHERE r.question_id = $1 AND b.user_id = $2
     )
     SELECT o.*, t.title AS triggered_by_title
       FROM ordered o
       LEFT JOIN question t ON t.id = o.triggered_by_question_id
      ORDER BY o.created_at, o.id`,
    [questionId, userId],
  );
}

/* ------------------------------------------------------------------- relations */

export interface RelatedQuestion {
  relation_id: string;
  kind: RelationKind;
  direction: 'out' | 'in';
  note: string | null;
  id: string;
  title: string;
  state: State;
  book_id: string;
  book_title: string;
}

export function relations(userId: string, questionId: string): Promise<RelatedQuestion[]> {
  return rows<RelatedQuestion>(
    `SELECT r.id AS relation_id, r.kind, 'out' AS direction, r.note,
            q.id, q.title, q.state, q.book_id, b.title AS book_title
       FROM question_relation r
       JOIN question q ON q.id = r.to_id
       JOIN book b ON b.id = q.book_id
      WHERE r.from_id = $1 AND b.user_id = $2
     UNION ALL
     SELECT r.id AS relation_id, r.kind, 'in' AS direction, r.note,
            q.id, q.title, q.state, q.book_id, b.title AS book_title
       FROM question_relation r
       JOIN question q ON q.id = r.from_id
       JOIN book b ON b.id = q.book_id
      WHERE r.to_id = $1 AND b.user_id = $2`,
    [questionId, userId],
  );
}

/**
 * Both endpoints must belong to the caller. Relations cross books freely (D6) but
 * never cross accounts — a link into someone else's graph would expose their title.
 */
export async function createRelation(
  userId: string,
  input: { from_id: string; to_id: string; kind: RelationKind; note?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.from_id === input.to_id)
    return { ok: false, error: 'a question cannot relate to itself' };

  const mine = await rows<{ id: string }>(
    `SELECT q.id FROM question q JOIN book b ON b.id = q.book_id
      WHERE q.id = ANY($1::text[]) AND b.user_id = $2`,
    [`{${input.from_id},${input.to_id}}`, userId],
  );
  if (mine.length < 2) return { ok: false, error: 'question not found' };

  const inserted = await count(
    `INSERT INTO question_relation (id, from_id, to_id, kind, note)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (from_id, to_id, kind) DO NOTHING`,
    [newId(), input.from_id, input.to_id, input.kind, input.note ?? null],
  );
  return inserted ? { ok: true } : { ok: false, error: 'that relation already exists' };
}

export async function deleteRelation(userId: string, id: string): Promise<boolean> {
  return (
    (await count(
      `DELETE FROM question_relation r
        WHERE r.id = $1
          AND EXISTS (SELECT 1 FROM question q JOIN book b ON b.id = q.book_id
                       WHERE q.id = r.from_id AND b.user_id = $2)`,
      [id, userId],
    )) > 0
  );
}

/**
 * Every edge touching one book, for the map. Includes links that cross into another
 * of the learner's books (D6) — the far endpoint's title and book carry along so a
 * book-scoped map can render a cross-book connection without fetching every book.
 */
export function bookEdges(userId: string, bookId: string) {
  return rows<{
    from_id: string;
    to_id: string;
    kind: RelationKind;
    note: string | null;
    from_title: string;
    from_book_id: string;
    from_book_title: string;
    to_title: string;
    to_book_id: string;
    to_book_title: string;
    crosses: number;
  }>(
    `SELECT r.from_id, r.to_id, r.kind, r.note,
            a.title AS from_title, a.book_id AS from_book_id, ab.title AS from_book_title,
            c.title AS to_title,   c.book_id AS to_book_id,   cb.title AS to_book_title,
            CASE WHEN a.book_id = c.book_id THEN 0 ELSE 1 END AS crosses
       FROM question_relation r
       JOIN question a ON a.id = r.from_id JOIN book ab ON ab.id = a.book_id
       JOIN question c ON c.id = r.to_id   JOIN book cb ON cb.id = c.book_id
      WHERE (a.book_id = $1 OR c.book_id = $1)
        AND ab.user_id = $2 AND cb.user_id = $2`,
    [bookId, userId],
  );
}

/* ----------------------------------------------------------------------- drill */

export function dueQuestions(
  userId: string,
  limit = 20,
): Promise<(Question & { book_title: string })[]> {
  return rows(
    `SELECT q.*, b.title AS book_title
       FROM question q JOIN book b ON b.id = q.book_id
      WHERE b.user_id = $1
        AND q.parked_at IS NULL
        AND q.state <> 'unexplored'
        AND q.understanding IS NOT NULL
        AND q.next_review_at IS NOT NULL
        AND q.next_review_at <= now()
      ORDER BY q.next_review_at
      LIMIT $2`,
    [userId, limit],
  );
}

export function submitReview(
  userId: string,
  input: { question_id: string; rating: Rating; recalled?: string | null },
) {
  return tx(async (t: Tx) => {
    const q = await t.row<Question>(
      `SELECT q.* FROM question q JOIN book b ON b.id = q.book_id
        WHERE q.id = $1 AND b.user_id = $2 FOR UPDATE OF q`,
      [input.question_id, userId],
    );
    if (!q) return undefined;

    const after = applyRating(q.state, input.rating);
    await t.count(
      `INSERT INTO review (id, question_id, rating, recalled, state_before, state_after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), q.id, input.rating, input.recalled ?? null, q.state, after],
    );
    const question = await t.row<Question>(
      `UPDATE question SET state = $2, next_review_at = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [q.id, after, nextReviewAt(input.rating)],
    );
    return { question: question!, state_before: q.state, state_after: after };
  });
}

/* --------------------------------------------------------------------- sources */

export function sourcesFor(userId: string, questionId: string) {
  return rows(
    `SELECT s.*, qs.excerpt
       FROM question_source qs
       JOIN source s ON s.id = qs.source_id
       JOIN question q ON q.id = qs.question_id
       JOIN book b ON b.id = q.book_id
      WHERE qs.question_id = $1 AND b.user_id = $2
      ORDER BY s.created_at`,
    [questionId, userId],
  );
}

/* ----------------------------------------------------------------------- stats */

export async function bookStats(userId: string, bookId: string) {
  const counts = await rows<{ state: State; n: number }>(
    `SELECT q.state, count(*) AS n
       FROM question q JOIN book b ON b.id = q.book_id
      WHERE q.book_id = $1 AND b.user_id = $2
      GROUP BY q.state`,
    [bookId, userId],
  );
  const extra = await row<{ parked: number; due: number; total: number }>(
    `SELECT
       coalesce(sum(CASE WHEN q.parked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS parked,
       coalesce(sum(CASE WHEN q.next_review_at IS NOT NULL AND q.next_review_at <= now()
                          AND q.parked_at IS NULL THEN 1 ELSE 0 END), 0) AS due,
       count(*) AS total
     FROM question q JOIN book b ON b.id = q.book_id
    WHERE q.book_id = $1 AND b.user_id = $2`,
    [bookId, userId],
  );
  return {
    by_state: Object.fromEntries(counts.map((c) => [c.state, c.n])) as Record<State, number>,
    parked: extra?.parked ?? 0,
    due: extra?.due ?? 0,
    total: extra?.total ?? 0,
  };
}

/* -------------------------------------------------------------- wikilinks */

export interface IndexedQuestion {
  id: string;
  title: string;
  state: State;
  book_id: string;
  book_title: string;
}

/** Every question the learner has, for `[[ ]]` autocomplete and link resolution. */
export function questionIndex(userId: string): Promise<IndexedQuestion[]> {
  return rows<IndexedQuestion>(
    `SELECT q.id, q.title, q.state, q.book_id, b.title AS book_title
       FROM question q JOIN book b ON b.id = q.book_id
      WHERE b.user_id = $1
      ORDER BY q.title`,
    [userId],
  );
}

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export function parseWikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKILINK)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * "The graph should emerge naturally from learning." A [[link]] the learner typed
 * is a connection they made, so it becomes a relation without extra ceremony.
 * Only ever adds — unlinking stays a deliberate act.
 */
export async function syncWikilinks(
  userId: string,
  questionId: string,
  text: string,
): Promise<number> {
  const titles = parseWikilinks(text);
  if (!titles.length) return 0;
  let added = 0;
  for (const title of titles) {
    const hit = await row<{ id: string }>(
      `SELECT q.id FROM question q JOIN book b ON b.id = q.book_id
        WHERE lower(q.title) = lower($1) AND b.user_id = $2 LIMIT 1`,
      [title, userId],
    );
    if (!hit || hit.id === questionId) continue;
    const res = await createRelation(userId, {
      from_id: questionId,
      to_id: hit.id,
      kind: 'related_to',
      note: 'linked from your notes',
    });
    if (res.ok) added++;
  }
  return added;
}

export { now };
