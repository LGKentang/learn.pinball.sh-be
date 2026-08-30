/**
 * Google sign-in, authorization-code flow.
 *
 * The code is exchanged server-side, so the client secret never reaches the
 * browser and no access token is ever handed to JavaScript — the only credential
 * the frontend holds is an httpOnly session cookie it cannot read.
 */
import { env } from '../env.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export function authorizeUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', env.google.clientId);
  url.searchParams.set('redirect_uri', env.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Without this a signed-in Google user is bounced straight back, which makes
  // "sign in as someone else" impossible.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * The id_token arrives over TLS directly from Google's token endpoint in response
 * to our authenticated request, so its signature adds nothing here and Google's own
 * documentation says to skip verification on this path. Decode, do not trust
 * anything that arrived by another route.
 */
function decodeIdToken(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('id_token is malformed');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export async function exchangeCode(code: string): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('google response carried no id_token');

  const claims = decodeIdToken(body.id_token);
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!sub || !email) throw new Error('google identity is missing sub or email');

  return {
    sub,
    email,
    // An unverified address could belong to someone else entirely, and the
    // allowlist is keyed on the address.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
  };
}
