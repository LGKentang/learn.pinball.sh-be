# Deploying Pinball Learn

Three things have to line up: DNS and TLS for the wildcard, the Google OAuth client,
and the S3 bucket. Everything else is `docker compose`.

---

## 1. Cloudflare: DNS and TLS

Two records, both **proxied** (orange cloud):

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| `A` | `learn` | your origin IP | Proxied |
| `A` | `*` | your origin IP | Proxied |

`learn.pinball.sh` serves the application. `*.pinball.sh` serves everyone's published
sites — the backend reads the handle from the `Host` header, so nothing needs to be
added per user.

The app's own hostname is never mistaken for a tenant: `handleFromHost` returns null
for `PINBALL_APP_ORIGIN`'s host before it looks at anything else, and `learn` is in
`RESERVED_HANDLES`, so nobody can claim it even if that check were removed.

**The wildcard is one label deep and no deeper.** Cloudflare Universal SSL issues a
certificate for `pinball.sh` and `*.pinball.sh` only. `alice.pinball.sh` is covered;
`k8s.alice.pinball.sh` is not, and would need Cloudflare for SaaS. This is why the
URL shape is a subdomain per person and a path per book:

```
https://alice.pinball.sh/                        their published books
https://alice.pinball.sh/why-pods-dont-schedule  one book
```

Settings worth checking:

- **SSL/TLS → Overview:** Full (strict) if your origin has a real certificate,
  Full otherwise. Never Flexible — it strips HTTPS between Cloudflare and the origin,
  and the session cookie is marked `Secure`.
- **SSL/TLS → Edge Certificates:** Always Use HTTPS **on**.
- Proxying is what makes the wildcard certificate apply, so do not grey-cloud these.

> If you ever want people on their *own* domains (`notes.alice.com`), that is
> Cloudflare for SaaS with custom hostnames. Nothing in the code assumes it is
> absent — `handleFromHost` would need one branch — but it is not built.

---

## 2. Google OAuth

Google Cloud console → **APIs & Services → Credentials → Create credentials → OAuth
client ID → Web application**.

**Authorised JavaScript origins**

```
https://learn.pinball.sh
http://localhost:5173          (development)
```

**Authorised redirect URIs**

```
https://learn.pinball.sh/api/auth/google/callback
http://localhost:5173/api/auth/google/callback
```

The redirect URI must match `GOOGLE_REDIRECT_URI` character for character — Google
compares it literally, trailing slash included.

On the **OAuth consent screen**, the only scopes needed are `openid`, `email` and
`profile`. These are non-sensitive, so no Google verification review is required.

Then:

```bash
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_REDIRECT_URI=https://learn.pinball.sh/api/auth/google/callback
```

### Who can sign in

Invite-only (D14). An address gets in three ways:

```bash
PINBALL_ALLOWLIST=you@example.com,@yourcompany.com   # emails, or a whole domain
PINBALL_BOOTSTRAP_EMAIL=you@example.com             # also becomes admin
```

…or a row in `signup_allowlist`, which the admin API manages:

```bash
curl -X POST https://learn.pinball.sh/api/admin/allowlist \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"email":"friend@example.com","note":"beta"}'
```

Anyone not on the list is bounced to the sign-in screen with a clear message rather
than a silent failure.

---

## 3. S3

Any S3-compatible bucket works — AWS, Cloudflare R2, MinIO.

```bash
PINBALL_STORAGE=s3
S3_BUCKET=pinball-uploads
S3_REGION=ap-southeast-1
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_BASE=https://cdn.pinball.sh      # CloudFront / R2 custom domain
S3_PREFIX=uploads
# S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # R2 or MinIO
```

Objects are **public-read with 128-bit random filenames** (D13). Published pages have
to load images from another origin and from strangers' browsers, so presigning would
mean a round trip per image and no CDN caching. The accepted consequence: an image in
an unpublished book is readable by anyone holding its URL.

Grant public read with a **bucket policy**, not object ACLs — most buckets now have
ACLs disabled, and sending one is then a hard error:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadUploads",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::pinball-uploads/uploads/*"
  }]
}
```

The IAM user needs only `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
`arn:aws:s3:::pinball-uploads/*`.

Set `S3_ACL=public-read` **only** if the bucket still has object ACLs enabled — an
older AWS bucket. Leave it unset everywhere else; on a modern AWS bucket it fails the
upload, and R2 has no object ACLs to set.

### Cloudflare R2

R2 differs from AWS in three ways that matter here:

```bash
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # account host only
S3_BUCKET=learn-pinball                                     # NOT part of the endpoint
S3_REGION=auto                                              # a real region fails signing
S3_PUBLIC_BASE=https://cdn.pinball.sh
# S3_ACL stays unset — R2 has no object ACLs
```

There is **no bucket policy to apply**: the JSON above is AWS-only. Public read comes
from **R2 → your bucket → Settings → Custom Domains**, which provisions DNS and a
certificate and puts Cloudflare's cache in front. The `r2.dev` development URL on the
same page works too, but Cloudflare rate-limits it and says not to use it in
production.

`S3_PUBLIC_BASE` must be that custom domain, never the `r2.cloudflarestorage.com`
endpoint — the S3 API requires signed requests and answers an anonymous `<img>` with
a 401.

### Switching from local disk

Stored markdown always references `/api/uploads/<name>`, whichever driver is behind
it. Flipping `PINBALL_STORAGE` to `s3` therefore needs no rewrite of anyone's notes —
the route stops streaming bytes and starts redirecting to the CDN. Copy the existing
files across first, keeping their names:

```bash
aws s3 sync ./data/uploads s3://pinball-uploads/uploads/
```

---

## 4. Environment

Everything, in one place:

```bash
NODE_ENV=production
DATABASE_URL=postgres://user:pass@db:5432/pinball
PGSSL=require                     # managed Postgres only

PINBALL_APP_ORIGIN=https://learn.pinball.sh
PINBALL_BASE_DOMAIN=pinball.sh
SESSION_SECRET=                   # openssl rand -base64 32

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://learn.pinball.sh/api/auth/google/callback

PINBALL_ALLOWLIST=
PINBALL_BOOTSTRAP_EMAIL=

PINBALL_STORAGE=s3
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE=
```

The server refuses to boot in production without `SESSION_SECRET` and the Google
credentials, and without the S3 keys when `PINBALL_STORAGE=s3`. Failing at startup
beats failing at the first sign-in.

`PINBALL_DEV_LOGIN` is ignored entirely when `NODE_ENV=production` — the route is
never registered.

---

## 5. Running it

Migrations apply automatically at boot, holding a Postgres advisory lock, so several
replicas starting at once is safe.

```bash
docker compose --profile full up -d --build
```

The frontend image is nginx with two server blocks: `${APP_HOST}` serves the SPA and
proxies `/api`, and the default server proxies everything else straight to the
backend — that is the published-sites path. Build it with:

```bash
docker build -t pinball-fe ../learn.pinball.sh-fe
docker run -e APP_HOST=learn.pinball.sh -e BACKEND=api:8787 -p 80:80 pinball-fe
```

`proxy_set_header Host $host` is load-bearing in both blocks: the handle is read from
the `Host` header, and rewriting it would make every published site a 404.

---

## 6. Bringing the old SQLite data across

```bash
npm run import:sqlite -- /path/to/pinball.db
```

Every book is assigned to `PINBALL_BOOTSTRAP_EMAIL`, and the account is created
*without* a Google identity. The first Google sign-in from that same address binds to
it, so the data is simply there. Ids are preserved and every insert is
`ON CONFLICT DO NOTHING`, so re-running imports only what is missing.

---

## 7. Observability

### Metrics — `GET /metrics`

Prometheus text format, unauthenticated (that is how Prometheus expects to scrape),
kept private the same way Postgres is: it is never on the public proxy path — nginx's
`${APP_HOST}` block only forwards `/api/`, and the default block that catches every
other Host proxies to the backend but nothing routes `/metrics` there. Point Alloy at
`pinball-api:8787/metrics` directly on `reverse-proxy-network` (or `internal`, if you
put Alloy on that network instead); do not publish this port or proxy the path
publicly.

Everything on it, defined in `src/metrics.ts`:

| Metric | Labels | What it tells you |
| --- | --- | --- |
| `http_requests_total` | `method`, `route`, `status_code` | Request rate and error rate (RED). `route` is the matched **pattern** (`/books/:id`), never a raw URL — see below. |
| `http_request_duration_seconds` | same | Latency histogram; `histogram_quantile` for p50/p95/p99. |
| `pg_pool_connections` | `state` (`total`/`idle`/`waiting`) | Connection pool pressure — a sustained `waiting > 0` means requests are queueing for a connection. |
| `pinball_auth_signins_total` | `result` (`success`, `not_allowed`, `unverified_email`, `exchange_failed`, `state_mismatch`, `google_error`) | Sign-in funnel; a spike in anything but `success` is worth alerting on. |
| `pinball_uploads_total`, `pinball_upload_bytes_total` | `storage` (`local`/`s3`) | Upload volume, useful for catching a storage misconfiguration (driver mismatch) or abuse. |
| `pinball_publish_actions_total` | `action` (`publish`/`unpublish`) | Publishing activity. |
| `pinball_questions_created_total` | — | Learning activity, coarse. |
| `pinball_revisions_total` | `kind` | Same, broken down by revision kind. |
| `pinball_drill_reviews_total` | `rating` | Drill engagement and how it's going. |
| `process_*`, `nodejs_*` | — | Standard Node process metrics (CPU, memory, event loop lag, GC, handles) from `collectDefaultMetrics()` — these are the exact names the standard Grafana "Node.js Application Dashboard" (id 11159) expects, so that dashboard works with zero relabeling. |

**Why `route` is a pattern, not a URL:** every HTTP label here comes from a fixed,
small set of values — `request.routeOptions.url`, the string Fastify matched
(`/questions/:id`), not `request.url` (which contains a real id). A label with
unbounded cardinality is how a Prometheus TSDB falls over; nothing in this app ever
puts a user id, a book id, or free text on a metric label. That detail is what
`pinball_auth_signins_total`'s `google_error` bucket exists for too — Google's own
`error` query parameter is free text we do not control, so it collapses to one label
value on the metric and only appears as real text in the log line next to it.

### Logs

Fastify's built-in Pino logger, JSON to stdout — one object per line, which is what
`loki.source.docker` / `discovery.docker` + a `json` processing stage in Alloy expects
with no extra work. Configured in `server.ts`:

- **`service: "pinball-api"`, `env`** on every line — filter to this service first
  in a multi-service Loki setup.
- **`userId`** is bound onto the request's logger the moment a session resolves
  (`auth/session.ts`), so every log line for an authenticated request carries it —
  request handlers do not pass it around by hand.
- **`redact`** blanks `req.headers.cookie`, `req.headers.authorization` and
  `res.headers["set-cookie"]` wherever a log line might include them — the session
  and OAuth-state cookies are bearer credentials and must never reach a log, even via
  an incidental full-request dump.
- A handful of state-changing actions get an explicit `event`-tagged line beyond
  Fastify's own access log: `event: "auth_signin"` (both outcomes), `event:
  "book_published"` / `"book_unpublished"`. Add more the same way — `req.log.info({
  event: '...', ...ids }, 'human sentence')` — for anything else worth grepping for
  on its own rather than reconstructing from the access log.

**Recommended Loki label vs. structured-metadata split**, since promoting the wrong
fields to Loki *labels* is what makes a Loki index fall over the same way an
unbounded Prometheus label does: keep labels to the low-cardinality set —

```
job, service, env, level
```

and let everything else (`userId`, `bookId`, `reqId`, `route`, `statusCode`, `event`)
live as parsed JSON / Loki structured metadata instead. In an Alloy `loki.process`
component that is a `json` stage extracting fields, a `labels` stage promoting only
`service`/`env`/`level`, and a `structured_metadata` stage (or just leaving the rest
in the parsed line) for everything with real ids in it.

**Example LogQL, once `service`/`env` are labels and the rest is parsed JSON:**

```logql
# Everything from this service
{service="pinball-api"} | json

# Errors only
{service="pinball-api"} | json | level="error"

# One person's activity across every request
{service="pinball-api"} | json | userId="<uuid>"

# Server errors, to correlate with a spike in http_requests_total{status_code=~"5.."}
{service="pinball-api"} | json | statusCode >= 500

# The sign-in funnel, failures only
{service="pinball-api"} | json | event="auth_signin" | result!="success"

# Publishing activity
{service="pinball-api"} | json | event=~"book_published|book_unpublished"

# A specific request end-to-end (grab reqId from any line, e.g. from an error)
{service="pinball-api"} | json | reqId="req-42"
```

---

## Checks after a deploy

```bash
curl -s https://learn.pinball.sh/health
# {"ok":true,"storage":"s3","domain":"pinball.sh"}

# an unclaimed subdomain should be a 404 page, not an error
curl -sI https://nobody.pinball.sh/ | head -1

# a published book
curl -s https://alice.pinball.sh/some-book | grep -o '<title>.*</title>'
```

If `/health` is fine but sign-in loops back to the sign-in screen, the cookie is
being dropped: check that `PINBALL_APP_ORIGIN` starts with `https://` (that is what
sets `Secure`) and that Cloudflare SSL is not set to Flexible.
