# Data Model

This file resolves the contradictions and undefined terms left open in `PRODUCT.md`.
Where a decision was needed it is recorded below with its rationale. Override any of
them — but override them *here*, so there stays exactly one source of truth.

**Engine:** SQLite (`node:sqlite`, built into Node 24 — no native build, no server).
Enums are `TEXT` + `CHECK` constraints, which is also what makes this port to Postgres
by swapping the checks for `CREATE TYPE ... AS ENUM` and `TEXT` ids for `uuid`.

---

## Decisions

### D1. Hierarchy lives on `question.parent_id`, not in `question_relation`

`PRODUCT.md` describes parenthood twice: as a field on Question, and as a `PARENT_OF`
relation type. Two sources of truth drift.

**Resolution:** the parent/child spine is an FK column. `PARENT_OF` is *removed* from the
relation kinds; `question_relation` holds only non-hierarchical links.

Rationale: "navigation between parent and child questions must feel instantaneous." A
self-FK delivers that with a recursive CTE and makes cycles cheap to check. The graph
still exists — it is the FK spine plus the relation edges — without paying for a
generalized edge table on the hottest read path.

### D2. `Parked` is not an understanding state

`PRODUCT.md` makes parked questions a V1 priority but never puts "parked" in the state
enum or the data model.

**Resolution:** parking is *orthogonal* to understanding. A parked question can be
`unexplored` or `exploring`. It is `parked_at` + `park_reason`.

Rationale: a sixth state would destroy the state it replaced — un-parking would have
nowhere to return to.

### D3. `Verified` gets an entry condition

Listed in both drafts, never defined; as written it is unbuildable.

**Resolution:** `verified` means the learner produced an explanation from memory in a
drill *and* reconciled it against a source. Checkable: a question may enter `verified`
only if it has a review rated `could_explain_deeply` and at least one linked source.
Enforced in application code.

Alternative if that feels like ceremony: cut `verified` and stop at `can_explain`. Four
states are enough to validate the loop.

### D4. Drill ratings map to states by floor/ceiling

`PRODUCT.md` says "review results determine what should be revisited" with no rule.

| Rating | Effect on state | Next review |
| --- | --- | --- |
| `didnt_know` | demote to `exploring` | +1 day |
| `partially_knew` | demote to `understood` if above it | +3 days |
| `knew_it` | raise to `understood` if below it | +7 days |
| `could_explain_deeply` | raise to `can_explain` if below it | +21 days |

Never auto-promotes to `verified` (D3). Intervals are deliberately crude fixed steps,
not SM-2: no ease factor, no card queue, no daily deck. That is what keeps this "active
recall, not a flashcard system" — the unit is a question you own, and the rating is
about explanation quality, not recall latency.

### D5. `Revision` carries a kind and a trigger, and stores each answer once

The Learning Trail renders *annotated* transitions ("↓ discovered misconception").
A bare before/after row cannot express that.

**Resolution:** every revision has a `kind`, an optional `note` (the annotation
itself), and an optional `triggered_by_question_id` — the subquestion whose
exploring prompted the parent's revision. That column is what makes "finishing a
subquestion should help the user return to and improve the parent answer" a
queryable relationship rather than a hope.

**There is no `understanding_before` column.** An earlier draft stored one, which
duplicated every answer: a question revised five times held its text ten times.
The previous answer is always the previous row's `understanding_after`, so it is
derived on read instead:

```sql
lag(understanding_after) OVER (PARTITION BY question_id ORDER BY created_at, id)
```

Not deltas. Git is the reference here and git stores *snapshots* — content-addressed
blobs, with delta compression confined to packfiles and invisible to the object
model. Storing deltas would make the trail O(n²) to render, since it shows every
version at once, and one bad delta would poison every version after it.

### D6. A question belongs to exactly one Book; relations may cross them

`question.book_id` is NOT NULL. `question_relation` deliberately does *not*
constrain both endpoints to the same book — that is how "a discovery in one
Book may connect to another" works. The Knowledge Map scopes to one book
and renders cross-book edges as a distinct class.

Naming note: `source.kind` has a literal enum value `'book'` (a physical or reference
book cited as evidence). That predates this entity and is unrelated to it — the
coincidence in name is not a bug.

### D7. `source` ships in the schema, not in the V1 UI

`PRODUCT.md` puts Source in the data model but omits sources from the V1 priority list.
The table is cheap and D3 depends on it; rich source management is post-V1.

### D8. "Keep V1 small" is restored as a principle

v1 of the spec ended its principles with "Keep V1 small." The rewrite dropped it while
the surface area grew (Books, Learning Intent, rabbit holes, parking, Sources).
That principle was the document's immune system. Treat it as principle 13.

---

### D9. Postgres, not SQLite

`node:sqlite` was the right call for one learner on one laptop: no server, no native
build, `npm run dev` and go. Accounts end that. Multi-tenancy wants row-level scoping
across concurrent writers, and SQLite serialises every write against a single file —
fine for one person, wrong for a shared deployment.

The port cost less than it looks because the schema was already written for it
(`TEXT` + `CHECK` rather than SQLite quirks). What changed:

| SQLite | Postgres |
| --- | --- |
| `?` placeholders | `$1`, `$2`, … |
| synchronous `.get()` / `.all()` | `await row()` / `await rows()` |
| `.run().changes` | `await count()` (`rowCount`) |
| `parent_id IS ?` | `parent_id IS NOT DISTINCT FROM $2` |
| `printf('%06d', position)` | `lpad(position::text, 6, '0')` |
| `INSERT` + catch unique violation | `ON CONFLICT … DO NOTHING` |
| TEXT ISO timestamps | `TIMESTAMPTZ`, compared against `now()` |
| guarded blocks in `db/index.ts` | ordered migrations in `db/migrations.ts` |

`count(*)` and `sum()` return `bigint`, which node-postgres hands over as a *string*.
A type parser in `db/index.ts` maps `INT8` to `Number`, because every bigint this app
selects is a row count — without it `stats.total` silently became `"37"`.

Migrations now record their id in `schema_migration` and hold a Postgres advisory
lock while running, so several API replicas booting at once is safe.

**The old data is not migrated in place.** `npm run import:sqlite` reads the SQLite
file and inserts into Postgres with ids preserved and `ON CONFLICT DO NOTHING`, so it
is re-runnable.

### D10. Sessions are server-side; the browser holds an opaque cookie

Google sign-in uses the authorization-code flow, exchanged server-side. The client
secret never reaches the browser and no access token or JWT is handed to JavaScript.
The only credential the frontend holds is an httpOnly cookie it cannot read.

`user_session.id` is the **SHA-256 of the cookie token**, not the token. A leaked
database backup therefore contains no usable session.

The cookie is **host-only** — no `Domain` attribute. This is the load-bearing detail:
published sites live at `<handle>.pinball.sh`, and a `Domain=.pinball.sh` cookie would
be sent to every one of them, handing a reader's session token to any page they visit.

The `id_token` from the token endpoint is decoded, not signature-verified. It arrived
over TLS directly from Google in response to our own authenticated request, which is
the one case Google's documentation says verification is unnecessary. Anything that
arrives by another route must be verified.

### D11. Ownership is a `user_id` on `book`, enforced in the query

Every other table cascades from `book`, so one foreign key scopes the whole model.

Ownership is filtered **inside the SQL**, never checked first and acted on second:

```sql
UPDATE question q SET title = $3
 WHERE q.id = $1
   AND EXISTS (SELECT 1 FROM book b WHERE b.id = q.book_id AND b.user_id = $2)
```

A forgotten guard then returns zero rows instead of someone else's book, and a
missing row and a forbidden row are indistinguishable from outside — existence is
not something to leak.

Relations still cross books freely (D6) but never cross accounts: `createRelation`
requires both endpoints to belong to the caller, or a link would expose a stranger's
question title through the map.

### D12. Publishing is per book, on a subdomain, server-rendered

A published book is readable at `<handle>.<base domain>/<slug>`. `book.published_at`
is the entire switch: null is private, set is public.

**One label deep, and no deeper.** Cloudflare Universal SSL covers `pinball.sh` and
`*.pinball.sh` — a wildcard certificate matches exactly one label, so
`k8s.alice.pinball.sh` would need Cloudflare for SaaS. Hence a subdomain per *person*
and a path per book.

Published pages are rendered to HTML by Fastify (`src/render/`), not by the SPA:
crawlable, real link previews, no JavaScript, and they survive a broken frontend
build. `routes/public.ts` is a separate file from `routes/api.ts` on purpose — the API
applies `requireUser` to every route in the file, so a public handler can never be
added to it by accident, and every query in the public path requires
`published_at IS NOT NULL`.

**Only current answers are published.** The Learning Trail, drill ratings, parked
rabbit holes and unanswered questions all stay private. An unanswered question is a
private to-do, not a publication.

A handle cannot be changed once claimed. Every published URL contains it; changing it
would break other people's links and free the old name for whoever wanted it.

### D13. Images are public objects with unguessable names

Markdown always stores `/api/uploads/<name>`. That path is the stable public identity
of an image and never changes, whichever driver is behind it — switching
`PINBALL_STORAGE` from `local` to `s3` needs no rewrite of anyone's notes. The route
either streams the bytes or 302s to the CDN.

The access control is 128 bits of randomness in the filename. Uploading requires a
session; reading does not, because published pages have to load these from another
origin and from strangers' browsers. The consequence, accepted deliberately: an image
in an *unpublished* book is readable by anyone holding its URL.

No SVG. It is a script container and these are served from domains we own.

### D14. Signup is invite-only

Handles are permanent public URLs on a domain we own, so open registration is an
abuse surface before it is a growth channel. An address gets in via
`PINBALL_ALLOWLIST`, a row in `signup_allowlist`, or by being
`PINBALL_BOOTSTRAP_EMAIL`. A bare `@domain.com` entry admits a whole domain.

Existing users are never re-checked: once in, they stay in.

### D15. A Book sits on at most one Library, never more

`library` groups Books the way a shelf groups books: `book.library_id` is a nullable
FK, not a join table. A book with no library is simply unsorted, not an error state.

This doesn't change D11 — `book.user_id` is still the enforced ownership boundary for
everything below it, and Library sits *beside* that chain rather than replacing it.
Assigning a `library_id` is checked in the same query that writes it (an `EXISTS`
against `library.user_id`), so pointing a book at someone else's library fails the
same way every other ownership guard in this codebase does: no row, not an error.

Deleting a Library sets `library_id` back to null on its books (`ON DELETE SET NULL`)
rather than deleting them — a shelf coming down doesn't burn the books on it.

No publishing at the Library level yet. D12 is about one Book on one subdomain path;
a Library-level index page is a real design question of its own, left for later.

---

## Schema

> The executable source of truth is `src/db/migrations.ts`. What follows is the
> shape and the reasoning; where the two disagree, the migrations are right.
> Timestamps are `TIMESTAMPTZ` since D9 — shown as `TEXT` below only where the
> original note predates the port.

```sql
-- A person. google_sub is null until their first sign-in, which is what lets the
-- SQLite importer create the owner of the pre-OAuth data ahead of time (D9, D10).
CREATE TABLE app_user (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  avatar_url  TEXT,
  handle      TEXT UNIQUE,       -- the subdomain; permanent once claimed (D12)
  bio         TEXT,
  is_admin    BOOLEAN NOT NULL DEFAULT false,
  can_publish BOOLEAN NOT NULL DEFAULT true,
  CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$')
);

-- id is the SHA-256 of the cookie token, never the token itself (D10).
CREATE TABLE user_session (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE signup_allowlist (email TEXT PRIMARY KEY, note TEXT);

CREATE TABLE library (        -- a named shelf of books, optional (D15)
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE book (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,  -- D11
  title        TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  intent       TEXT,             -- Learning Intent; nullable so creation stays frictionless
  library_id   TEXT REFERENCES library(id) ON DELETE SET NULL,  -- D15, null = unsorted
  slug         TEXT,             -- URL segment on the published site
  published_at TIMESTAMPTZ,      -- null = private. The whole publishing switch (D12)
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  archived_at  TIMESTAMPTZ,
  CHECK (published_at IS NULL OR slug IS NOT NULL)
);
CREATE UNIQUE INDEX book_slug_per_user ON book (user_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX book_by_library ON book (library_id);

CREATE TABLE question (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES question(id) ON DELETE CASCADE,   -- D1
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),
  understanding  TEXT,           -- current mental model, in the learner's own words
  state          TEXT NOT NULL DEFAULT 'unexplored'
                 CHECK (state IN ('unexplored','exploring','understood','can_explain','verified')),
  position       INTEGER NOT NULL DEFAULT 0,
  parked_at      TEXT,           -- D2
  park_reason    TEXT,
  next_review_at TEXT,           -- D4; NULL = not in drill rotation
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (park_reason IS NULL OR parked_at IS NOT NULL)
);

-- Non-hierarchical edges. May cross books (D6).
CREATE TABLE question_relation (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL
             CHECK (kind IN ('related_to','depends_on','contradicts','example_of')),
  note       TEXT,
  created_at TEXT NOT NULL,
  CHECK (from_id <> to_id),
  UNIQUE (from_id, to_id, kind)
);

-- Append-only history. Never UPDATE question.understanding without writing one of these.
-- no understanding_before: it is the previous row's understanding_after (D5)
CREATE TABLE revision (
  id                       TEXT PRIMARY KEY,
  question_id              TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  understanding_after      TEXT,
  kind                     TEXT NOT NULL DEFAULT 'refinement'
                           CHECK (kind IN ('initial','refinement','misconception_corrected',
                                           'merged_from_child','post_drill')),
  note                     TEXT,   -- the trail annotation: "discovered misconception"
  triggered_by_question_id TEXT REFERENCES question(id) ON DELETE SET NULL,   -- D5
  created_at               TEXT NOT NULL
);

CREATE TABLE source (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('book','article','paper','video','lecture','website',
                                 'experiment','conversation','personal_observation')),
  title          TEXT NOT NULL,
  locator        TEXT,           -- url, ISBN, page, timestamp — free-form on purpose
  created_at     TEXT NOT NULL
);

CREATE TABLE question_source (
  question_id TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  excerpt     TEXT,              -- what the source says, kept distinct from understanding
  PRIMARY KEY (question_id, source_id)
);

-- One drill attempt. Append-only.
CREATE TABLE review (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  rating       TEXT NOT NULL
               CHECK (rating IN ('didnt_know','partially_knew','knew_it','could_explain_deeply')),
  recalled     TEXT,             -- produced from memory, before seeing stored understanding
  state_before TEXT NOT NULL,
  state_after  TEXT NOT NULL,
  reviewed_at  TEXT NOT NULL
);

CREATE INDEX question_by_parent      ON question (parent_id);
CREATE INDEX question_by_book        ON question (book_id, parent_id, position);
CREATE INDEX question_due            ON question (next_review_at);
CREATE INDEX relation_from           ON question_relation (from_id, kind);
CREATE INDEX relation_to             ON question_relation (to_id, kind);
CREATE INDEX revision_by_question    ON revision (question_id, created_at);
CREATE INDEX revision_by_trigger     ON revision (triggered_by_question_id);
CREATE INDEX review_by_question      ON review (question_id, reviewed_at);
```

---

## Queries the views depend on

**Book tree** — the main workspace:

```sql
WITH RECURSIVE tree AS (
  SELECT id, parent_id, title, state, parked_at, 0 AS depth, printf('%06d', position) AS path
    FROM question WHERE book_id = ? AND parent_id IS NULL
  UNION ALL
  SELECT q.id, q.parent_id, q.title, q.state, q.parked_at, t.depth + 1,
         t.path || '.' || printf('%06d', q.position)
    FROM question q JOIN tree t ON q.parent_id = t.id
)
SELECT * FROM tree ORDER BY path;
```

**Path back to the origin** — "always preserve the path back to the original question":

```sql
WITH RECURSIVE up AS (
  SELECT id, parent_id, title, 0 AS height FROM question WHERE id = ?
  UNION ALL
  SELECT q.id, q.parent_id, q.title, u.height + 1
    FROM question q JOIN up u ON u.parent_id = q.id
)
SELECT * FROM up ORDER BY height DESC;   -- root first
```

**Drill queue** — due, not parked, actually explored:

```sql
SELECT * FROM question
 WHERE next_review_at <= ? AND parked_at IS NULL AND state <> 'unexplored'
 ORDER BY next_review_at LIMIT 20;
```

**Unexplored branches** — the Knowledge Map's real job, available before any
visualization exists:

```sql
SELECT id, title, state FROM question
 WHERE book_id = ? AND state = 'unexplored' AND parked_at IS NULL
 ORDER BY created_at;
```

---

## Invariants for application code

1. Never overwrite `question.understanding` without inserting a `revision` in the same
   transaction. *Preserve misconceptions and reasoning history.*
2. `question.parent_id` must not form a cycle. The FK cannot express this; walk
   ancestors on re-parent.
3. Every `review` insert recomputes `state_after` and `next_review_at` by D4.
4. Deleting a book cascades to its questions, revisions, reviews, and sources.
   Cross-book relation rows vanish with their endpoint — acceptable, since the
   edge is meaningless once one side is gone.
5. Every query outside `routes/public.ts` filters on the acting `user_id` in SQL.
   Ownership is never established by a separate read.
6. Nothing in `routes/public.ts` consults `req.user`. A published page renders
   identically for its author and for a stranger — the only way to be certain a
   draft cannot leak through a cache.
7. Deleting a library sets `library_id` to null on its books; it never deletes them
   (D15).
