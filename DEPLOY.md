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
