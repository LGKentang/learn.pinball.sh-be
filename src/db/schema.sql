-- Pinball Learn V1 schema. See SCHEMA.md at the workspace root for the decisions
-- behind it (D1-D8). SQLite flavour; enums are TEXT + CHECK so this ports to Postgres.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS book (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  intent      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS question (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES question(id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),
  understanding  TEXT,
  state          TEXT NOT NULL DEFAULT 'unexplored'
                 CHECK (state IN ('unexplored','exploring','understood','can_explain','verified')),
  position       INTEGER NOT NULL DEFAULT 0,
  parked_at      TEXT,
  park_reason    TEXT,
  next_review_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (park_reason IS NULL OR parked_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS question_relation (
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

-- No understanding_before column: it is always the previous revision's
-- understanding_after, so storing it duplicated every answer (see SCHEMA.md D5).
CREATE TABLE IF NOT EXISTS revision (
  id                       TEXT PRIMARY KEY,
  question_id              TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  understanding_after      TEXT,
  kind                     TEXT NOT NULL DEFAULT 'refinement'
                           CHECK (kind IN ('initial','refinement','misconception_corrected',
                                           'merged_from_child','post_drill')),
  note                     TEXT,
  triggered_by_question_id TEXT REFERENCES question(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('book','article','paper','video','lecture','website',
                                 'experiment','conversation','personal_observation')),
  title          TEXT NOT NULL,
  locator        TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_source (
  question_id TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  excerpt     TEXT,
  PRIMARY KEY (question_id, source_id)
);

CREATE TABLE IF NOT EXISTS review (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  rating       TEXT NOT NULL
               CHECK (rating IN ('didnt_know','partially_knew','knew_it','could_explain_deeply')),
  recalled     TEXT,
  state_before TEXT NOT NULL,
  state_after  TEXT NOT NULL,
  reviewed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS question_by_parent      ON question (parent_id);
CREATE INDEX IF NOT EXISTS question_by_book        ON question (book_id, parent_id, position);
CREATE INDEX IF NOT EXISTS question_due            ON question (next_review_at);
CREATE INDEX IF NOT EXISTS relation_from           ON question_relation (from_id, kind);
CREATE INDEX IF NOT EXISTS relation_to             ON question_relation (to_id, kind);
CREATE INDEX IF NOT EXISTS revision_by_question    ON revision (question_id, created_at);
CREATE INDEX IF NOT EXISTS revision_by_trigger     ON revision (triggered_by_question_id);
CREATE INDEX IF NOT EXISTS review_by_question      ON review (question_id, reviewed_at);
