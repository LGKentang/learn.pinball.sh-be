# Exploration → Book rename: done

Plan reference: `/home/darren/.claude/plans/pure-sparking-bumblebee.md` on the
machine this was built on (not checked into either repo).

The full feature described there is complete and verified in both repos:

- Backend: schema/migration/queries/types/routes/seed scripts renamed, docs
  (PRODUCT.md, SCHEMA.md, CLAUDE.md) read-through renamed. Migration verified
  both against a hand-built legacy database and against the real seeded Docker
  volume — existing books/questions survive the rename.
- Frontend: full rename (api client, views, CSS) plus the actual navigation
  feature — a Books picker, `#/b/<id>` / `#/b/<id>/map` / `#/b/<id>/outline`
  routes, a persisted current-book (URL + localStorage fallback) driving the
  Explore/Map nav links, and cross-book question links working under the
  now-single-book-scoped Map (surfaced in the per-question inspector, tagged
  with the other book's title).

Verified end to end against the running Docker stack: typecheck and build
clean in both repos, the rename migration preserves real data, and a full
walk (Books → Explore → Map/Outline → follow a cross-book link → confirm the
current book switched → nav falls back to the last book with no route/after a
fresh profile) all behave as designed. No console errors on any route.

This file is now historical — safe to delete once read.
