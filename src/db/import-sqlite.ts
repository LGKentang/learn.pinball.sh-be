/**
 * One-off import of the pre-Postgres SQLite database.
 *
 *   npm run import:sqlite [-- path/to/pinball.db]
 *
 * Books had no owner before accounts existed, so every one of them is assigned to
 * PINBALL_BOOTSTRAP_EMAIL (falling back to the demo address). That account is
 * created without a google_sub, so the first Google sign-in from the same address
 * binds to it and the data is simply there — see routes/auth.ts.
 *
 * Re-running is safe: ids carry over unchanged and every insert is ON CONFLICT DO
 * NOTHING, so a second run imports only what is missing.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './index.js';
import { seedUser, SEED_EMAIL } from './seed-user.js';

const here = dirname(fileURLToPath(import.meta.url));
const path =
  process.argv[2] ?? process.env.PINBALL_SQLITE ?? resolve(here, '../../data/pinball.db');

if (!existsSync(path)) {
  console.error(`no SQLite database at ${path}`);
  console.error('pass one:  npm run import:sqlite -- ../old/pinball.db');
  process.exit(1);
}

const userId = await seedUser();
const sqlite = new DatabaseSync(path, { readOnly: true });

const table = (name: string): Record<string, unknown>[] => {
  const exists = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  if (!exists) return [];
  return sqlite.prepare(`SELECT * FROM ${name}`).all().map((r) => ({ ...r }));
};

// The rename shipped mid-flight, so accept either spelling.
const bookRows = table('book').length ? table('book') : table('exploration');
const bookIdOf = (r: Record<string, unknown>) => (r.book_id ?? r.exploration_id) as string;

const questions = table('question');
const relations = table('question_relation');
const revisions = table('revision');
const sources = table('source');
const questionSources = table('question_source');
const reviews = table('review');

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number => (v == null ? 0 : Number(v));

const counts = await tx(async (t) => {
  const done = {
    books: 0,
    questions: 0,
    revisions: 0,
    relations: 0,
    sources: 0,
    questionSources: 0,
    reviews: 0,
  };

  for (const b of bookRows) {
    done.books += await t.count(
      `INSERT INTO book (id, user_id, title, intent, created_at, updated_at, archived_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [s(b.id), userId, s(b.title), s(b.intent), s(b.created_at), s(b.updated_at), s(b.archived_at)],
    );
  }

  // Parents before children, so the self-referencing foreign key always resolves.
  const byId = new Map(questions.map((q) => [String(q.id), q]));
  const ordered: Record<string, unknown>[] = [];
  const placed = new Set<string>();
  const place = (q: Record<string, unknown>, guard = 0) => {
    const id = String(q.id);
    if (placed.has(id) || guard > 64) return;
    const parent = s(q.parent_id);
    if (parent && byId.has(parent) && !placed.has(parent)) place(byId.get(parent)!, guard + 1);
    placed.add(id);
    ordered.push(q);
  };
  for (const q of questions) place(q);

  for (const q of ordered) {
    done.questions += await t.count(
      `INSERT INTO question (id, book_id, parent_id, title, understanding, state, position,
                             parked_at, park_reason, next_review_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [
        s(q.id), bookIdOf(q), s(q.parent_id), s(q.title), s(q.understanding),
        s(q.state) ?? 'unexplored', n(q.position), s(q.parked_at), s(q.park_reason),
        s(q.next_review_at), s(q.created_at), s(q.updated_at),
      ],
    );
  }

  for (const r of revisions) {
    done.revisions += await t.count(
      `INSERT INTO revision (id, question_id, understanding_after, kind, note,
                             triggered_by_question_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        s(r.id), s(r.question_id), s(r.understanding_after), s(r.kind) ?? 'refinement',
        s(r.note), s(r.triggered_by_question_id), s(r.created_at),
      ],
    );
  }

  for (const r of relations) {
    done.relations += await t.count(
      `INSERT INTO question_relation (id, from_id, to_id, kind, note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [s(r.id), s(r.from_id), s(r.to_id), s(r.kind), s(r.note), s(r.created_at)],
    );
  }

  for (const src of sources) {
    done.sources += await t.count(
      `INSERT INTO source (id, book_id, kind, title, locator, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [s(src.id), bookIdOf(src), s(src.kind), s(src.title), s(src.locator), s(src.created_at)],
    );
  }

  for (const qs of questionSources) {
    done.questionSources += await t.count(
      `INSERT INTO question_source (question_id, source_id, excerpt)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [s(qs.question_id), s(qs.source_id), s(qs.excerpt)],
    );
  }

  for (const rv of reviews) {
    done.reviews += await t.count(
      `INSERT INTO review (id, question_id, rating, recalled, state_before, state_after, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        s(rv.id), s(rv.question_id), s(rv.rating), s(rv.recalled),
        s(rv.state_before), s(rv.state_after), s(rv.reviewed_at),
      ],
    );
  }

  return done;
});

sqlite.close();

console.log(
  `imported from ${path} into Postgres, owned by ${SEED_EMAIL}\n` +
    `  books ${counts.books}/${bookRows.length}   questions ${counts.questions}/${questions.length}\n` +
    `  revisions ${counts.revisions}/${revisions.length}   relations ${counts.relations}/${relations.length}\n` +
    `  sources ${counts.sources}/${sources.length}   reviews ${counts.reviews}/${reviews.length}\n` +
    (counts.books < bookRows.length
      ? '  (rows already present were left alone — the import is re-runnable)'
      : ''),
);

await pool.end();
