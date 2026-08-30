# learn.pinball.sh — working instructions

**Pinball Learn** is a domain-agnostic learning platform built around questions,
exploration, and evolving understanding. Not a note app, not a course platform, not a
flashcard system.

- Product spec: `PRODUCT.md` — read it before changing product behaviour. It is not
  loaded automatically.
- Data model, and the decisions that resolve the spec's open questions: `SCHEMA.md`.
  Decisions there are numbered `D1`–`D14`; cite them when changing behaviour they cover.
- Cloudflare DNS/TLS, the Google OAuth client, the S3 bucket policy, and the env
  reference: `DEPLOY.md`.

All of these live in this repo. The frontend is a sibling checkout (see below) and has
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

- **Backend:** Node 24, TypeScript, Fastify, **PostgreSQL** via `pg` (D9).
  `docker compose up -d db` gives you one locally.
- **Frontend:** Vite, React 19, TypeScript. Plain CSS, no UI framework. CodeMirror 6
  powers the live-preview markdown editor.
- **Auth:** Google OAuth, authorization-code flow, server-side session in an httpOnly
  host-only cookie (D10). Signup is invite-only (D14).
- **Published sites:** `<handle>.pinball.sh`, rendered to HTML by Fastify in
  `src/render/` and served by `src/routes/public.ts` (D12).
- **Uploads:** `ImageStore` in `src/storage.ts` — local disk or S3, selected by
  `PINBALL_STORAGE`. Stored markdown always says `/api/uploads/<name>` either way (D13).

## Commands

Backend (this repo):

```
npm install
cp .env.example .env         # then fill in at least SESSION_SECRET
docker compose -f docker-compose.yml -f compose.dev.yml up -d db   # Postgres on :5432
npm run migrate              # apply pending migrations (dev also does this at boot)
npm run dev                  # tsx watch, http://localhost:8787
npm run seed                 # reset + load the demo books for the seed account
npm run seed:k8s             # add the Kubernetes topics (additive, safe to re-run)
npm run import:sqlite        # one-off: carry a pre-Postgres data/pinball.db across
npm run build                # tsc -> dist/
npm start                    # run built output
```

Without Google credentials, set `PINBALL_DEV_LOGIN` to an allowlisted address and the
sign-in screen offers a local-developer button. It is refused outright when
`NODE_ENV=production`.

Frontend (`learn.pinball.sh-fe/`):

```
npm install
npm run dev      # vite, http://localhost:5173, proxies /api -> :8787
npm run build
```

Run both; the frontend proxies `/api` to the backend, so no CORS config is needed in dev.

To look at a published site locally, address the backend by a tenant host — the
handle is read from `Host`, and `*.localhost` is accepted for exactly this reason:

```
curl -H 'Host: alice.localhost' http://127.0.0.1:8787/
```

## Conventions

- **Domain-agnostic.** Never hardcode subject-specific behaviour. The same code serves
  Kubernetes, macroeconomics, Roman history, and Japanese particles.
- **History is append-only.** Never overwrite `question.understanding` without writing a
  `revision` row in the same transaction. Misconceptions are the product, not garbage.
- **Keep V1 small.** Check `PRODUCT.md`'s *V1 Scope* and *Not V1* before adding a
  surface. See `SCHEMA.md` D8.
- Frictionless subquestion creation is a hard requirement, not a nicety — if a change
  adds a step to that flow, it is the wrong change.
- SQL lives in `src/db/`; route handlers stay thin. Learning content is in
  `queries.ts`, accounts and publishing in `users.ts`.
- **Scope every query on `user_id` inside the SQL** (D11). Never check ownership with
  a separate read — a forgotten guard must return no rows, not someone else's book.
- **`routes/public.ts` never reads `req.user`.** It is the only unauthenticated read
  path; every query in it requires `published_at IS NOT NULL`. Do not add public
  routes to `routes/api.ts`, which applies `requireUser` to the whole file.
- Migrations are append-only entries in `src/db/migrations.ts`, recorded in
  `schema_migration`. Never edit one that has shipped; add the next one.

## V1 definition of done

The loop closes end to end: create a book with an intent → ask a question →
write current understanding → create subquestions → descend and return → revise the
parent → mark understanding → get drilled on it later.
