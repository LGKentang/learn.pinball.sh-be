# learn.pinball.sh — working instructions

**Pinball Learn** is a domain-agnostic learning platform built around questions,
exploration, and evolving understanding. Not a note app, not a course platform, not a
flashcard system.

- Product spec: `PRODUCT.md` — read it before changing product behaviour. It is not
  loaded automatically.
- Data model, and the decisions that resolve the spec's open questions: `SCHEMA.md`.
  Decisions there are numbered `D1`–`D8`; cite them when changing behaviour they cover.

All three live in this repo. The frontend is a sibling checkout (see below) and has
no copy of them — read them from here.

## Layout

This repo is the backend. It sits beside the frontend in a workspace directory that
is **not itself a git repository**:

```
learn.pinball.sh/            (workspace, not a repo)
├── learn.pinball.sh-be/     this repo — API, database, and the docs
└── learn.pinball.sh-fe/     web client, separate repo
```

| Repo | Role | Remote |
| --- | --- | --- |
| `learn.pinball.sh-be` | API + database + docs | `git@github.com:LGKentang/learn.pinball.sh-be.git` |
| `learn.pinball.sh-fe` | Web client | `git@github.com:LGKentang/learn.pinball.sh-fe.git` |

Each has its own history. Never stage or commit across both in one operation.

## Stack

- **Backend:** Node 24, TypeScript, Fastify, SQLite via built-in `node:sqlite`.
  No native modules, no database server — `npm install && npm run dev` is the whole setup.
- **Frontend:** Vite, React 19, TypeScript. Plain CSS, no UI framework. CodeMirror 6
  powers the live-preview markdown editor.
- **Uploads:** images go to local disk behind the `ImageStore` interface in
  `src/storage.ts`; S3 slots in there without touching routes or stored markdown.
- Postgres is the eventual target; `SCHEMA.md` documents the port.

## Commands

Backend (this repo):

```
npm install
npm run dev      # tsx watch, http://localhost:8787
npm run seed     # reset + load the demo explorations
npm run seed:k8s # add the Kubernetes topics (additive, safe to re-run)
npm run build    # tsc -> dist/
npm start        # run built output
```

Frontend (`learn.pinball.sh-fe/`):

```
npm install
npm run dev      # vite, http://localhost:5173, proxies /api -> :8787
npm run build
```

Run both; the frontend proxies `/api` to the backend, so no CORS config is needed in dev.
The database file is `learn.pinball.sh-be/data/pinball.db` (gitignored).

## Conventions

- **Domain-agnostic.** Never hardcode subject-specific behaviour. The same code serves
  Kubernetes, macroeconomics, Roman history, and Japanese particles.
- **History is append-only.** Never overwrite `question.understanding` without writing a
  `revision` row in the same transaction. Misconceptions are the product, not garbage.
- **Keep V1 small.** Check `PRODUCT.md`'s *V1 Scope* and *Not V1* before adding a
  surface. See `SCHEMA.md` D8.
- Frictionless subquestion creation is a hard requirement, not a nicety — if a change
  adds a step to that flow, it is the wrong change.
- SQL lives in `src/db/`; route handlers stay thin.
- Migrations are guarded blocks in `src/db/index.ts` — check before altering, so a
  restart is always a no-op on an up-to-date database.

## V1 definition of done

The loop closes end to end: create an exploration with an intent → ask a question →
write current understanding → create subquestions → descend and return → revise the
parent → mark understanding → get drilled on it later.
