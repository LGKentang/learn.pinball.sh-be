/**
 * Every environment knob in one place, read once at boot so a missing variable is
 * a startup failure rather than a 500 three days later.
 *
 * Nothing here throws when a credential is absent: the app has to be runnable
 * before the Google and S3 credentials exist. Instead each block reports whether
 * it is configured, and the features that need it degrade with a clear message.
 */

const str = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();

export const isProduction = process.env.NODE_ENV === 'production';

/** Hostname without port — Host headers carry one in dev, and we compare on host. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
};

const appOrigin = str('PINBALL_APP_ORIGIN', 'http://localhost:5173').replace(/\/+$/, '');

const google = {
  clientId: str('GOOGLE_CLIENT_ID'),
  clientSecret: str('GOOGLE_CLIENT_SECRET'),
  redirectUri: str('GOOGLE_REDIRECT_URI', `${appOrigin}/api/auth/google/callback`),
};

const s3 = {
  bucket: str('S3_BUCKET'),
  region: str('S3_REGION', 'us-east-1'),
  endpoint: str('S3_ENDPOINT') || undefined,
  accessKeyId: str('S3_ACCESS_KEY_ID'),
  secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
  /** Public read base, e.g. a CloudFront or Cloudflare hostname in front of the bucket. */
  publicBase: str('S3_PUBLIC_BASE').replace(/\/+$/, ''),
  prefix: str('S3_PREFIX', 'uploads'),
};

export const env = {
  port: Number(str('PORT', '8787')),
  host: str('HOST', '127.0.0.1'),

  databaseUrl: str('DATABASE_URL', 'postgres://pinball:pinball@127.0.0.1:5432/pinball'),

  /** The apex that published sites are subdomains of: alice.<baseDomain>. */
  baseDomain: str('PINBALL_BASE_DOMAIN', 'pinball.sh').toLowerCase(),
  appOrigin,
  appHost: hostOf(appOrigin),

  /** Signs session cookies. Random per boot in dev, which just logs everyone out. */
  sessionSecret: str('SESSION_SECRET') || (isProduction ? '' : crypto.randomUUID()),

  google,
  googleConfigured: Boolean(google.clientId && google.clientSecret),

  storage: (str('PINBALL_STORAGE', 'local') === 's3' ? 's3' : 'local') as 'local' | 's3',
  s3,
  s3Configured: Boolean(s3.bucket && s3.accessKeyId && s3.secretAccessKey),
  uploadsDir: str('PINBALL_UPLOADS'),

  /** First login with this address adopts every book that has no owner yet. */
  bootstrapEmail: str('PINBALL_BOOTSTRAP_EMAIL').toLowerCase(),

  /** Comma-separated emails, or @domain.com to allow a whole domain. */
  allowlist: str('PINBALL_ALLOWLIST')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /**
   * Development-only escape hatch so the app is usable before the Google
   * credentials arrive. Ignored outright when NODE_ENV=production — see
   * routes/auth.ts, which refuses to register the route at all.
   */
  devLoginEmail: isProduction ? '' : str('PINBALL_DEV_LOGIN').toLowerCase(),
};

/** Hard failures worth refusing to boot over, but only where it is truly unsafe. */
export function assertBootable(): void {
  const problems: string[] = [];
  if (!env.databaseUrl) problems.push('DATABASE_URL is required');
  if (isProduction && !env.sessionSecret)
    problems.push('SESSION_SECRET is required in production');
  if (isProduction && !env.googleConfigured)
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production');
  if (env.storage === 's3' && !env.s3Configured)
    problems.push('PINBALL_STORAGE=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  if (problems.length) {
    throw new Error(`configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Subdomains nobody may claim as a handle: they are ours, or they are confusing. */
export const RESERVED_HANDLES = new Set([
  'www', 'api', 'app', 'admin', 'root', 'mail', 'smtp', 'imap', 'pop', 'ns', 'ns1', 'ns2',
  'dns', 'mx', 'ftp', 'cdn', 'static', 'assets', 'img', 'images', 'media', 'files', 'uploads',
  'blog', 'docs', 'doc', 'help', 'support', 'status', 'dashboard', 'account', 'accounts',
  'auth', 'login', 'logout', 'signup', 'signin', 'oauth', 'sso', 'billing', 'pay', 'payments',
  'store', 'shop', 'dev', 'staging', 'stage', 'test', 'demo', 'preview', 'beta', 'alpha',
  'internal', 'private', 'public', 'me', 'my', 'you', 'user', 'users', 'profile', 'about',
  'legal', 'terms', 'privacy', 'security', 'abuse', 'postmaster', 'webmaster', 'hostmaster',
  'pinball', 'learn', 'graph', 'book', 'books', 'question', 'questions', 'drill', 'map',
]);

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function handleProblem(handle: string): string | null {
  if (!HANDLE_RE.test(handle))
    return 'use 3-32 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen';
  if (handle.includes('--')) return 'two hyphens in a row are not allowed';
  if (RESERVED_HANDLES.has(handle)) return 'that name is reserved';
  return null;
}
