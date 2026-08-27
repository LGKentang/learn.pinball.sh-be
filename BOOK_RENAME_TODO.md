# Exploration → Book rename: progress

Full plan (approved): `/home/darren/.claude/plans/pure-sparking-bumblebee.md` on
this machine — not checked into either repo. Re-read it before continuing; this
file is just a status snapshot, not a replacement for it.

Summary of the feature: rename "Exploration" to "Book" everywhere (DB/API/docs/UI),
require picking a Book before entering Explore or Map, persist that choice across
Explore ↔ Map (via the URL plus a `localStorage` fallback), add a "Books" nav item
to go back and pick a different one, and keep cross-book question links working in
the Map once it's scoped to a single book instead of showing every book at once.
Drill stays global across all books (explicit decision, not an oversight).

## Done — this repo (`learn.pinball.sh-be`)

- `src/db/schema.sql` — table `exploration` → `book`; `question.exploration_id` →
  `book_id`; `source.exploration_id` → `book_id`; index renamed.
- `src/db/index.ts` — guarded migration added **before** `db.exec(schema.sql)` that
  renames an existing `exploration` table/columns to `book` on old databases, so a
  restart doesn't orphan real data. Also drops the stale `question_by_exploration`
  index (its replacement is created by schema.sql under the new name).
- `src/db/queries.ts` — full rename: `listBooks`, `getBook`, `createBook`,
  `updateBook`, `deleteBook`, `bookTree`, `bookStats`, `bookEdges`. `bookEdges` (was
  `explorationEdges`) was also **extended** to return the far endpoint's title and
  book id/title (`from_title`, `from_book_id`, `from_book_title`, `to_title`,
  `to_book_id`, `to_book_title`) — needed so the frontend Map can render a cross-book
  connection stub without fetching every other book. `RelatedQuestion` and
  `IndexedQuestion` fields renamed `book_id`/`book_title`.
- `src/types.ts` — `Exploration` → `Book`; `Question.exploration_id` → `book_id`.
  (`SOURCE_KINDS` still has a literal `'book'` value — that's an unrelated,
  pre-existing "physical book cited as a source" concept, deliberately untouched.)
- `src/routes/api.ts` — `/explorations*` → `/books*`; question-create body field
  `exploration_id` → `book_id`; `/questions/:id` response key `exploration` → `book`.
- `src/db/seed.ts`, `src/db/seed-k8s.ts` — updated to the renamed functions/fields;
  print "books" instead of "explorations".
- Verified: `npm run typecheck` passes. Ran `seed.ts` + `seed-k8s.ts` against a
  **fresh** throwaway DB (`/tmp/pinball-test/fresh.db`) — both succeed and produce
  the expected counts.

## Not yet verified

- The `exploration` → `book` **migration path on an existing/old-schema database**
  was attempted but not completed (tried to hand-build a legacy SQLite DB via the
  `sqlite3` CLI, which isn't installed in this environment). Before trusting the
  migration against the real seeded Docker volume: either install `sqlite3`, or
  write a tiny Node script using `node:sqlite`'s `DatabaseSync` directly to build a
  pre-rename DB, then run the backend against it and confirm the book/question data
  survives with the new column names.
- Have **not yet rebuilt the Docker backend image** or run it against the existing
  `learnpinballsh_pinball-data` volume (which has the old `exploration` schema from
  our earlier seeding) — this is the real end-to-end test of the migration.

## Not started

**Backend docs** (still say "Exploration" throughout):
- `PRODUCT.md` — read-through rename ("Learning Exploration" heading, "Minimal Data
  Model", "Primary Views", etc. — prose-aware, not blind find/replace).
- `SCHEMA.md` — rename through the D1–D8 decisions (keep the numbering/rationale,
  reword to `book`/`book_id`), update the embedded SQL block to match the new
  `schema.sql`, and add a short callout that `source.kind = 'book'` is an unrelated,
  deliberately-untouched pre-existing value.
- `CLAUDE.md` — its handful of "Exploration" mentions.

**Frontend (`learn.pinball.sh-fe`) — entirely untouched, this is the bulk of what's left:**

- `src/api.ts` — `Exploration`→`Book`, `ExplorationSummary`→`BookSummary`,
  `ExplorationDetail`→`BookDetail`; `api.explorations()`→`api.books()`,
  `api.exploration(id)`→`api.book(id)`, `createExploration`→`createBook`, etc.
  `Edge` gains `from_title`, `from_book_id`, `from_book_title`, `to_title`,
  `to_book_id`, `to_book_title` (matches the extended backend `bookEdges`).
- `src/graph.ts` — `GNode.explorationId/explorationTitle` → `bookId/bookTitle`;
  `useGraph` calls the renamed `api.books()`/`api.book(id)`.
- **`src/views/Home.tsx` + `src/views/TopicPicker.tsx` → merge into one
  `src/views/Books.tsx`.** They currently overlap (Home = list/create/stats;
  TopicPicker = search-across-books-and-questions + jump-to). Delete both old files.
- `src/views/Exploration.tsx` → `src/views/Book.tsx` (component `BookView`):
  `explorationId` prop → `bookId`; `ExplorationHeader` → `BookHeader`; `#/e/...`
  links → `#/b/...`.
- `src/views/Canvas.tsx` — always receives a `bookId` now (no more inline
  `TopicPicker` fallback — App.tsx redirects to Books when one's missing from the
  route). `explorationId` → `bookId`; "⌕ Topics" button → `#/books`; internal
  `#/walk/...` → `#/b/<id>/map/...`.
- `src/views/Map.tsx` — becomes **book-scoped**: takes a `bookId` prop, fetches only
  `api.book(bookId)` (not every book). Cross-book edges (far endpoint not in the
  local node set) render as a stub connector using the new `to_title`/
  `to_book_title` fields, clicking navigates to `#/b/<targetBookId>/q/<id>`.
- `src/App.tsx` — new route union (`books` / `book` / `canvas` / `outline` / `drill`,
  see the plan file for the exact shape); add
  `currentBookId` state seeded from and written through to
  `localStorage['pinball:lastBookId']` whenever the active route carries a book id;
  top-nav Explore/Map links become `currentBookId ? #/b/${id}[/map] : #/books`; add
  a "Books" nav item.
- `src/styles.css`, `Note.tsx`, `Drill.tsx`, `MarkdownEditor.tsx` — mechanical
  follow-through: rename `exploration_id`/`exploration_title` field references and
  `#/e/...` links; rename `.explorations`/`.exp-*` CSS classes to `.books`/`.book-*`.

## Verification checklist (once everything above is done)

- `npm run typecheck` and `npm run build` in both repos.
- Rebuild both Docker images and restart against the **existing seeded volume**
  specifically to exercise the migration on real data.
- Manual walk: Books → create/pick a book → open a question in Explore → switch to
  Map (book persists) → follow a cross-book stub link (current book switches) →
  Books nav → pick a different book → Explore/Map now scope to it → refresh
  mid-Explore (URL alone reproduces state) → reopen with no hash at all (nav falls
  back to the last book via `localStorage`).
- Re-run `npm run seed` and `npm run seed:k8s` against a fresh database.
