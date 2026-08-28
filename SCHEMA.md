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

## Schema

```sql
CREATE TABLE book (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  intent      TEXT,              -- Learning Intent; nullable so creation stays frictionless
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

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
