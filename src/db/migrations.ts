/**
 * Ordered, append-only migrations. Each runs once inside its own transaction and
 * its id is recorded in `schema_migration`; never edit one that has shipped, add
 * the next one instead.
 *
 * 001 is the whole schema in one statement because the move from SQLite to
 * Postgres was a fresh database — the old file is imported by
 * `npm run import:sqlite`, not migrated in place.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_base',
    sql: /* sql */ `
      -- A person. google_sub is null until their first Google sign-in, which lets
      -- the importer create the owner of the pre-OAuth data ahead of time and have
      -- the real account bind to it on first login (see auth/google.ts).
      CREATE TABLE IF NOT EXISTS app_user (
        id          TEXT PRIMARY KEY,
        google_sub  TEXT UNIQUE,
        email       TEXT NOT NULL UNIQUE,
        name        TEXT,
        avatar_url  TEXT,
        -- The subdomain their published notes live on: <handle>.pinball.sh.
        -- Null until claimed; validated in code against RESERVED_HANDLES too.
        handle      TEXT UNIQUE,
        bio         TEXT,
        is_admin    BOOLEAN NOT NULL DEFAULT false,
        can_publish BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ,
        CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$')
      );

      -- Signup is closed while this is early: an address has to be listed here (or
      -- in PINBALL_ALLOWLIST) before a Google account can become a user.
      CREATE TABLE IF NOT EXISTS signup_allowlist (
        email      TEXT PRIMARY KEY,
        note       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- id is the SHA-256 of the cookie token, so a leaked database backup does not
      -- hand over live sessions.
      CREATE TABLE IF NOT EXISTS user_session (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        user_agent   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_by_user ON user_session (user_id);
      CREATE INDEX IF NOT EXISTS session_expiry  ON user_session (expires_at);

      CREATE TABLE IF NOT EXISTS book (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        title        TEXT NOT NULL CHECK (length(btrim(title)) > 0),
        intent       TEXT,
        -- Publishing (D12): a book is public exactly when published_at is set, and
        -- it is then readable at <handle>.pinball.sh/<slug>.
        slug         TEXT,
        published_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at  TIMESTAMPTZ,
        CHECK (published_at IS NULL OR slug IS NOT NULL),
        CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$')
      );
      CREATE INDEX IF NOT EXISTS book_by_user ON book (user_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS book_slug_per_user ON book (user_id, slug)
        WHERE slug IS NOT NULL;

      CREATE TABLE IF NOT EXISTS question (
        id             TEXT PRIMARY KEY,
        book_id        TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        parent_id      TEXT REFERENCES question(id) ON DELETE CASCADE,
        title          TEXT NOT NULL CHECK (length(btrim(title)) > 0),
        understanding  TEXT,
        state          TEXT NOT NULL DEFAULT 'unexplored'
                       CHECK (state IN ('unexplored','exploring','understood','can_explain','verified')),
        position       INTEGER NOT NULL DEFAULT 0,
        parked_at      TIMESTAMPTZ,
        park_reason    TEXT,
        next_review_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (from_id <> to_id),
        UNIQUE (from_id, to_id, kind)
      );

      -- No understanding_before column: it is always the previous revision's
      -- understanding_after, so storing it duplicated every answer (SCHEMA.md D5).
      CREATE TABLE IF NOT EXISTS revision (
        id                       TEXT PRIMARY KEY,
        question_id              TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
        understanding_after      TEXT,
        kind                     TEXT NOT NULL DEFAULT 'refinement'
                                 CHECK (kind IN ('initial','refinement','misconception_corrected',
                                                 'merged_from_child','post_drill')),
        note                     TEXT,
        triggered_by_question_id TEXT REFERENCES question(id) ON DELETE SET NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source (
        id         TEXT PRIMARY KEY,
        book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL
                   CHECK (kind IN ('book','article','paper','video','lecture','website',
                                   'experiment','conversation','personal_observation')),
        title      TEXT NOT NULL,
        locator    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Images are public objects with unguessable names (D13); this table exists so
      -- an upload has an owner for quota and cleanup, not to gate reads.
      CREATE TABLE IF NOT EXISTS upload (
        name         TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        bytes        INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS upload_by_user ON upload (user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS question_by_parent   ON question (parent_id);
      CREATE INDEX IF NOT EXISTS question_by_book     ON question (book_id, parent_id, position);
      CREATE INDEX IF NOT EXISTS question_due         ON question (next_review_at);
      CREATE INDEX IF NOT EXISTS relation_from        ON question_relation (from_id, kind);
      CREATE INDEX IF NOT EXISTS relation_to          ON question_relation (to_id, kind);
      CREATE INDEX IF NOT EXISTS revision_by_question ON revision (question_id, created_at);
      CREATE INDEX IF NOT EXISTS revision_by_trigger  ON revision (triggered_by_question_id);
      CREATE INDEX IF NOT EXISTS review_by_question   ON review (question_id, reviewed_at);
    `,
  },
  {
    id: '002_library',
    sql: /* sql */ `
      -- A Library is an optional, named shelf a user can group their Books onto
      -- (SCHEMA.md D15). A Book sits on at most one shelf at a time; deleting a
      -- Library unshelves its Books rather than deleting them.
      CREATE TABLE IF NOT EXISTS library (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        title      TEXT NOT NULL CHECK (length(btrim(title)) > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS library_by_user ON library (user_id, updated_at DESC);

      ALTER TABLE book ADD COLUMN IF NOT EXISTS library_id TEXT REFERENCES library(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS book_by_library ON book (library_id);
    `,
  },
  {
    id: '003_library_favorite',
    sql: /* sql */ `
      -- Pinning a library keeps it out of the scroll once someone has more than a
      -- handful — favorites sort first, everything else stays ordered by recency.
      ALTER TABLE library ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false;
    `,
  },
];
