import { db, newId, now, row, rows, tx } from './index.js';
import {
  applyRating,
  nextReviewAt,
  type Exploration,
  type Question,
  type Rating,
  type RelationKind,
  type Revision,
  type RevisionKind,
  type State,
} from '../types.js';

/* ---------------------------------------------------------------- explorations */

export function listExplorations(): (Exploration & {
  question_count: number;
  open_count: number;
})[] {
  return rows(
    db.prepare(`
      SELECT e.*,
             (SELECT count(*) FROM question q WHERE q.exploration_id = e.id) AS question_count,
             (SELECT count(*) FROM question q WHERE q.exploration_id = e.id
                AND q.state = 'unexplored' AND q.parked_at IS NULL) AS open_count
        FROM exploration e
       WHERE e.archived_at IS NULL
       ORDER BY e.updated_at DESC
    `),
  );
}

export function getExploration(id: string): Exploration | undefined {
  return row(db.prepare('SELECT * FROM exploration WHERE id = ?'), id);
}

export function createExploration(title: string, intent: string | null): Exploration {
  const id = newId();
  const ts = now();
  db.prepare(
    'INSERT INTO exploration (id, title, intent, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(id, title, intent, ts, ts);
  return getExploration(id)!;
}

export function updateExploration(
  id: string,
  patch: { title?: string; intent?: string | null },
): Exploration | undefined {
  const current = getExploration(id);
  if (!current) return undefined;
  db.prepare('UPDATE exploration SET title = ?, intent = ?, updated_at = ? WHERE id = ?').run(
    patch.title ?? current.title,
    patch.intent === undefined ? current.intent : patch.intent,
    now(),
    id,
  );
  return getExploration(id)!;
}

export function deleteExploration(id: string): boolean {
  return db.prepare('DELETE FROM exploration WHERE id = ?').run(id).changes > 0;
}

/* ------------------------------------------------------------------- questions */

export function getQuestion(id: string): Question | undefined {
  return row(db.prepare('SELECT * FROM question WHERE id = ?'), id);
}

/** Depth-ordered tree for one exploration. */
export function explorationTree(explorationId: string): (Question & { depth: number })[] {
  return rows(
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT q.*, 0 AS depth, printf('%06d', q.position) AS path
          FROM question q
         WHERE q.exploration_id = ? AND q.parent_id IS NULL
        UNION ALL
        SELECT q.*, t.depth + 1, t.path || '.' || printf('%06d', q.position)
          FROM question q JOIN tree t ON q.parent_id = t.id
      )
      SELECT * FROM tree ORDER BY path
    `),
    explorationId,
  );
}

/** Root-first chain of ancestors, so the learner never loses the way back. */
export function ancestors(id: string): Pick<Question, 'id' | 'title' | 'state'>[] {
  return rows(
    db.prepare(`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, title, state, 0 AS height FROM question WHERE id = ?
        UNION ALL
        SELECT q.id, q.parent_id, q.title, q.state, u.height + 1
          FROM question q JOIN up u ON u.parent_id = q.id
      )
      SELECT id, title, state FROM up WHERE id <> ? ORDER BY height DESC
    `),
    id,
    id,
  );
}

export function children(id: string): Question[] {
  return rows(
    db.prepare('SELECT * FROM question WHERE parent_id = ? ORDER BY position, created_at'),
    id,
  );
}

export function createQuestion(input: {
  exploration_id: string;
  parent_id?: string | null;
  title: string;
}): Question {
  const id = newId();
  const ts = now();
  const parent = input.parent_id ?? null;
  const next = row<{ n: number }>(
    db.prepare(
      `SELECT coalesce(max(position), -1) + 1 AS n FROM question
        WHERE exploration_id = ? AND parent_id IS ?`,
    ),
    input.exploration_id,
    parent,
  );
  return tx(() => {
    db.prepare(
      `INSERT INTO question (id, exploration_id, parent_id, title, position, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, input.exploration_id, parent, input.title, next?.n ?? 0, ts, ts);
    // Asking a subquestion is itself evidence the parent is being worked on.
    if (parent) {
      db.prepare(
        `UPDATE question SET state = 'exploring', updated_at = ?
          WHERE id = ? AND state = 'unexplored'`,
      ).run(ts, parent);
    }
    db.prepare('UPDATE exploration SET updated_at = ? WHERE id = ?').run(
      ts,
      input.exploration_id,
    );
    return getQuestion(id)!;
  });
}

/**
 * Invariant 1: understanding never changes without a revision row in the same
 * transaction. The old text is the learning artifact, not garbage.
 */
export function reviseUnderstanding(input: {
  question_id: string;
  understanding: string;
  kind?: RevisionKind;
  note?: string | null;
  triggered_by_question_id?: string | null;
}): { question: Question; revision: Revision } | undefined {
  const q = getQuestion(input.question_id);
  if (!q) return undefined;
  const ts = now();
  const revId = newId();
  const kind: RevisionKind =
    input.kind ?? (q.understanding == null || q.understanding === '' ? 'initial' : 'refinement');

  return tx(() => {
    db.prepare(
      `INSERT INTO revision (id, question_id, understanding_after,
                             kind, note, triggered_by_question_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      revId,
      q.id,
      input.understanding,
      kind,
      input.note ?? null,
      input.triggered_by_question_id ?? null,
      ts,
    );
    const state: State = q.state === 'unexplored' ? 'exploring' : q.state;
    db.prepare(
      'UPDATE question SET understanding = ?, state = ?, updated_at = ? WHERE id = ?',
    ).run(input.understanding, state, ts, q.id);
    db.prepare('UPDATE exploration SET updated_at = ? WHERE id = ?').run(ts, q.exploration_id);
    return {
      question: getQuestion(q.id)!,
      revision: row<Revision>(db.prepare('SELECT * FROM revision WHERE id = ?'), revId)!,
    };
  });
}

export function setState(id: string, state: State): Question | undefined {
  const q = getQuestion(id);
  if (!q) return undefined;
  const ts = now();
  // D4: entering the rotation at all is what makes a question drillable.
  const next =
    q.next_review_at ?? (state === 'unexplored' ? null : nextReviewAt('knew_it', new Date()));
  db.prepare(
    'UPDATE question SET state = ?, next_review_at = ?, updated_at = ? WHERE id = ?',
  ).run(state, next, ts, id);
  return getQuestion(id)!;
}

/** D2: parking is orthogonal to understanding, so the state is left untouched. */
export function setParked(
  id: string,
  parked: boolean,
  reason?: string | null,
): Question | undefined {
  if (!getQuestion(id)) return undefined;
  const ts = now();
  db.prepare('UPDATE question SET parked_at = ?, park_reason = ?, updated_at = ? WHERE id = ?').run(
    parked ? ts : null,
    parked ? (reason ?? null) : null,
    ts,
    id,
  );
  return getQuestion(id)!;
}

export function renameQuestion(id: string, title: string): Question | undefined {
  if (!getQuestion(id)) return undefined;
  db.prepare('UPDATE question SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
  return getQuestion(id)!;
}

export function deleteQuestion(id: string): boolean {
  return db.prepare('DELETE FROM question WHERE id = ?').run(id).changes > 0;
}

/**
 * The previous answer is the previous row's — derived here rather than stored,
 * so the two can never disagree and each answer is kept exactly once.
 */
export function revisions(questionId: string): (Revision & { triggered_by_title: string | null })[] {
  return rows(
    db.prepare(`
      WITH ordered AS (
        SELECT r.*,
               lag(r.understanding_after) OVER (
                 PARTITION BY r.question_id ORDER BY r.created_at, r.id
               ) AS understanding_before
          FROM revision r
         WHERE r.question_id = ?
      )
      SELECT o.*, t.title AS triggered_by_title
        FROM ordered o
        LEFT JOIN question t ON t.id = o.triggered_by_question_id
       ORDER BY o.created_at, o.id
    `),
    questionId,
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
  exploration_id: string;
  exploration_title: string;
}

export function relations(questionId: string): RelatedQuestion[] {
  return rows(
    db.prepare(`
      SELECT r.id AS relation_id, r.kind, 'out' AS direction, r.note,
             q.id, q.title, q.state, q.exploration_id, e.title AS exploration_title
        FROM question_relation r
        JOIN question q ON q.id = r.to_id
        JOIN exploration e ON e.id = q.exploration_id
       WHERE r.from_id = ?
      UNION ALL
      SELECT r.id AS relation_id, r.kind, 'in' AS direction, r.note,
             q.id, q.title, q.state, q.exploration_id, e.title AS exploration_title
        FROM question_relation r
        JOIN question q ON q.id = r.from_id
        JOIN exploration e ON e.id = q.exploration_id
       WHERE r.to_id = ?
    `),
    questionId,
    questionId,
  );
}

export function createRelation(input: {
  from_id: string;
  to_id: string;
  kind: RelationKind;
  note?: string | null;
}): { ok: true } | { ok: false; error: string } {
  if (input.from_id === input.to_id) return { ok: false, error: 'a question cannot relate to itself' };
  if (!getQuestion(input.from_id) || !getQuestion(input.to_id))
    return { ok: false, error: 'question not found' };
  try {
    db.prepare(
      'INSERT INTO question_relation (id, from_id, to_id, kind, note, created_at) VALUES (?,?,?,?,?,?)',
    ).run(newId(), input.from_id, input.to_id, input.kind, input.note ?? null, now());
    return { ok: true };
  } catch {
    return { ok: false, error: 'that relation already exists' };
  }
}

export function deleteRelation(id: string): boolean {
  return db.prepare('DELETE FROM question_relation WHERE id = ?').run(id).changes > 0;
}

/** Every edge in one exploration, for the map. Includes cross-exploration links (D6). */
export function explorationEdges(explorationId: string) {
  return rows<{
    from_id: string;
    to_id: string;
    kind: RelationKind;
    note: string | null;
    crosses: number;
  }>(
    db.prepare(`
      SELECT r.from_id, r.to_id, r.kind, r.note,
             CASE WHEN a.exploration_id = b.exploration_id THEN 0 ELSE 1 END AS crosses
        FROM question_relation r
        JOIN question a ON a.id = r.from_id
        JOIN question b ON b.id = r.to_id
       WHERE a.exploration_id = ? OR b.exploration_id = ?
    `),
    explorationId,
    explorationId,
  );
}

/* ----------------------------------------------------------------------- drill */

export function dueQuestions(limit = 20): (Question & { exploration_title: string })[] {
  return rows(
    db.prepare(`
      SELECT q.*, e.title AS exploration_title
        FROM question q JOIN exploration e ON e.id = q.exploration_id
       WHERE q.parked_at IS NULL
         AND q.state <> 'unexplored'
         AND q.understanding IS NOT NULL
         AND q.next_review_at IS NOT NULL
         AND q.next_review_at <= ?
       ORDER BY q.next_review_at
       LIMIT ?
    `),
    now(),
    limit,
  );
}

export function submitReview(input: {
  question_id: string;
  rating: Rating;
  recalled?: string | null;
}) {
  const q = getQuestion(input.question_id);
  if (!q) return undefined;
  const after = applyRating(q.state, input.rating);
  const ts = now();
  const due = nextReviewAt(input.rating);
  return tx(() => {
    db.prepare(
      `INSERT INTO review (id, question_id, rating, recalled, state_before, state_after, reviewed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(newId(), q.id, input.rating, input.recalled ?? null, q.state, after, ts);
    db.prepare(
      'UPDATE question SET state = ?, next_review_at = ?, updated_at = ? WHERE id = ?',
    ).run(after, due, ts, q.id);
    return { question: getQuestion(q.id)!, state_before: q.state, state_after: after };
  });
}

/* --------------------------------------------------------------------- sources */

export function sourcesFor(questionId: string) {
  return rows(
    db.prepare(`
      SELECT s.*, qs.excerpt
        FROM question_source qs JOIN source s ON s.id = qs.source_id
       WHERE qs.question_id = ?
       ORDER BY s.created_at
    `),
    questionId,
  );
}

/* ----------------------------------------------------------------------- stats */

export function explorationStats(explorationId: string) {
  const counts = rows<{ state: State; n: number }>(
    db.prepare(
      'SELECT state, count(*) AS n FROM question WHERE exploration_id = ? GROUP BY state',
    ),
    explorationId,
  );
  const extra = row<{ parked: number; due: number; total: number }>(
    db.prepare(`
      SELECT
        sum(CASE WHEN parked_at IS NOT NULL THEN 1 ELSE 0 END) AS parked,
        sum(CASE WHEN next_review_at IS NOT NULL AND next_review_at <= ?
                  AND parked_at IS NULL THEN 1 ELSE 0 END) AS due,
        count(*) AS total
      FROM question WHERE exploration_id = ?
    `),
    now(),
    explorationId,
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
  exploration_id: string;
  exploration_title: string;
}

/** Every question, for `[[ ]]` autocomplete and link resolution. */
export function questionIndex(): IndexedQuestion[] {
  return rows(
    db.prepare(`
      SELECT q.id, q.title, q.state, q.exploration_id, e.title AS exploration_title
        FROM question q JOIN exploration e ON e.id = q.exploration_id
       ORDER BY q.title
    `),
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
export function syncWikilinks(questionId: string, text: string): number {
  const titles = parseWikilinks(text);
  if (!titles.length) return 0;
  const find = db.prepare('SELECT id FROM question WHERE lower(title) = lower(?) LIMIT 1');
  let added = 0;
  for (const title of titles) {
    const hit = row<{ id: string }>(find, title);
    if (!hit || hit.id === questionId) continue;
    const res = createRelation({
      from_id: questionId,
      to_id: hit.id,
      kind: 'related_to',
      note: 'linked from your notes',
    });
    if (res.ok) added++;
  }
  return added;
}
