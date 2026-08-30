import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env, isProduction } from '../env.js';
import { createSession, destroySession, useSession } from '../db/users.js';
import type { User } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null. Set by the onRequest hook below for every route. */
    user: User | null;
  }
}

export const SESSION_COOKIE = 'pinball_session';

/**
 * The cookie is deliberately host-only — no Domain attribute. Published sites live
 * at <handle>.pinball.sh, and a Domain=.pinball.sh cookie would be sent to every
 * one of them, handing a reader's session token to any page they visit (D12).
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.appOrigin.startsWith('https://'),
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** The database stores only the hash, so a stolen backup contains no usable session. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function startSession(
  reply: FastifyReply,
  user: User,
  userAgent: string | null,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await createSession(user.id, hashToken(token), userAgent);
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(30 * 24 * 60 * 60));
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await destroySession(hashToken(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolve the session cookie into req.user on every request. Never throws. */
export function sessionPlugin(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    try {
      req.user = (await useSession(hashToken(token))) ?? null;
    } catch (err) {
      req.log.warn({ err }, 'session lookup failed');
    }
  });
}

/** preHandler for everything under /api that touches a learner's own data. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: 'sign in to continue' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) return void (await reply.code(401).send({ error: 'sign in to continue' }));
  if (!req.user.is_admin) await reply.code(403).send({ error: 'not allowed' });
}

/* -------------------------------------------------- OAuth state (CSRF) cookie */

const STATE_COOKIE = 'pinball_oauth';

/**
 * The OAuth `state` round-trips through Google, so it has to be remembered on our
 * side. A short-lived cookie is the whole mechanism; it also carries where to send
 * the user afterwards.
 */
export function setOAuthState(reply: FastifyReply, state: string, returnTo: string): void {
  reply.setCookie(STATE_COOKIE, `${state}:${Buffer.from(returnTo).toString('base64url')}`, {
    ...cookieOptions(10 * 60),
    // Google's redirect back to us is a cross-site top-level GET; Lax allows it.
    sameSite: 'lax',
  });
}

export function takeOAuthState(
  req: FastifyRequest,
  reply: FastifyReply,
  state: string,
): { ok: boolean; returnTo: string } {
  const raw = req.cookies[STATE_COOKIE] ?? '';
  reply.clearCookie(STATE_COOKIE, { path: '/' });
  const [expected, encoded] = raw.split(':');
  if (!expected || !state) return { ok: false, returnTo: env.appOrigin };

  const a = Buffer.from(expected);
  const b = Buffer.from(state);
  const ok = a.length === b.length && timingSafeEqual(a, b);

  let returnTo = env.appOrigin;
  try {
    const decoded = Buffer.from(encoded ?? '', 'base64url').toString('utf8');
    // Only ever redirect back inside our own app — an open redirect here would
    // hand the freshly minted session cookie's origin to an attacker's page.
    if (decoded.startsWith(env.appOrigin)) returnTo = decoded;
  } catch {
    /* fall back to the app origin */
  }
  return { ok, returnTo };
}

export const newState = (): string => randomBytes(16).toString('base64url');

export { isProduction };
