import type { FastifyInstance } from 'fastify';
import { env, handleProblem, isProduction } from '../env.js';
import { authorizeUrl, exchangeCode, type GoogleIdentity } from '../auth/google.js';
import {
  endSession,
  newState,
  requireUser,
  setOAuthState,
  startSession,
  takeOAuthState,
} from '../auth/session.js';
import {
  createUser,
  findUserByEmail,
  findUserByGoogleSub,
  findUserByHandle,
  isAllowed,
  linkGoogleAccount,
  touchUser,
  updateProfile,
} from '../db/users.js';
import type { User } from '../types.js';

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
};

/** What the frontend is allowed to know about the signed-in user. */
function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatar_url: u.avatar_url,
    handle: u.handle,
    bio: u.bio,
    is_admin: u.is_admin,
    can_publish: u.can_publish,
    site_url: u.handle ? `https://${u.handle}.${env.baseDomain}` : null,
  };
}

type SignIn = { ok: true; user: User } | { ok: false; reason: 'not_allowed' | 'unverified_email' };

/**
 * Resolve a Google identity to an account.
 *
 * The email branch is what lets the pre-OAuth data keep its owner: the importer
 * creates that account with no google_sub, and the first matching sign-in binds to
 * it rather than creating a second, empty account.
 */
async function signIn(identity: GoogleIdentity): Promise<SignIn> {
  if (!identity.emailVerified) return { ok: false, reason: 'unverified_email' };

  const bySub = await findUserByGoogleSub(identity.sub);
  if (bySub) {
    await touchUser(bySub.id);
    return { ok: true, user: bySub };
  }

  const byEmail = await findUserByEmail(identity.email);
  if (byEmail) {
    const linked = await linkGoogleAccount(byEmail.id, {
      google_sub: identity.sub,
      name: identity.name,
      avatar_url: identity.picture,
    });
    return { ok: true, user: linked ?? byEmail };
  }

  if (!(await isAllowed(identity.email))) return { ok: false, reason: 'not_allowed' };

  const created = await createUser({
    email: identity.email,
    google_sub: identity.sub,
    name: identity.name,
    avatar_url: identity.picture,
    is_admin: identity.email === env.bootstrapEmail,
  });
  return created ? { ok: true, user: created } : { ok: false, reason: 'not_allowed' };
}

export async function auth(app: FastifyInstance) {
  /** Lets the sign-in screen know which buttons to offer. */
  app.get('/auth/config', async () => ({
    google: env.googleConfigured,
    dev: !isProduction && Boolean(env.devLoginEmail),
    base_domain: env.baseDomain,
  }));

  app.get('/auth/google/start', async (req, reply) => {
    if (!env.googleConfigured)
      return reply.code(503).send({ error: 'google sign-in is not configured' });
    const { return_to } = req.query as { return_to?: string };
    const state = newState();
    setOAuthState(reply, state, return_to ?? env.appOrigin);
    return reply.redirect(authorizeUrl(state));
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const checked = takeOAuthState(req, reply, state ?? '');
    const fail = (reason: string) =>
      reply.redirect(`${env.appOrigin}/?auth_error=${encodeURIComponent(reason)}`);

    if (error) return fail(error);
    if (!checked.ok) return fail('state_mismatch');
    if (!code) return fail('missing_code');

    let identity: GoogleIdentity;
    try {
      identity = await exchangeCode(code);
    } catch (err) {
      req.log.error({ err }, 'google code exchange failed');
      return fail('exchange_failed');
    }

    const result = await signIn(identity);
    if (!result.ok) return fail(result.reason);

    await startSession(reply, result.user, req.headers['user-agent'] ?? null);
    return reply.redirect(checked.returnTo);
  });

  /**
   * Development sign-in, so the app is usable before the Google credentials exist.
   * Registered only when NODE_ENV is not production *and* PINBALL_DEV_LOGIN names
   * an address — two independent switches, because the cost of getting this wrong
   * is an unauthenticated login endpoint in production.
   */
  if (!isProduction && env.devLoginEmail) {
    app.post('/auth/dev', async (req, reply) => {
      const email = env.devLoginEmail;
      let user = await findUserByEmail(email);
      if (!user) {
        if (!(await isAllowed(email)))
          return reply.code(403).send({ error: `${email} is not on the allowlist` });
        user = await createUser({
          email,
          name: 'Local Developer',
          is_admin: email === env.bootstrapEmail,
        });
      }
      if (!user) return reply.code(500).send({ error: 'could not create the dev user' });
      await startSession(reply, user, req.headers['user-agent'] ?? null);
      return { user: publicUser(user) };
    });
    app.log.warn(`dev sign-in enabled for ${env.devLoginEmail} — never set this in production`);
  }

  app.post('/auth/logout', async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  /* ------------------------------------------------------------------- me */

  app.get('/me', async (req) => (req.user ? { user: publicUser(req.user) } : { user: null }));

  app.patch('/me', { preHandler: requireUser }, async (req, reply) => {
    const me = req.user!;
    const body = req.body as Record<string, unknown>;
    const patch: { handle?: string; bio?: string | null; name?: string } = {};

    if ('handle' in body) {
      const raw = text(body.handle);
      if (!raw) return reply.code(400).send({ error: 'a handle is required' });
      const handle = raw.toLowerCase();
      // Changing a handle breaks every published link that points at the old one.
      if (me.handle && me.handle !== handle)
        return reply
          .code(409)
          .send({ error: 'your handle is already set — published links depend on it' });
      const problem = handleProblem(handle);
      if (problem) return reply.code(400).send({ error: problem });
      const taken = await findUserByHandle(handle);
      if (taken && taken.id !== me.id)
        return reply.code(409).send({ error: 'that handle is taken' });
      patch.handle = handle;
    }
    if ('bio' in body) patch.bio = text(body.bio);
    if ('name' in body) {
      const name = text(body.name);
      if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
      patch.name = name;
    }

    const updated = await updateProfile(me.id, patch);
    return { user: publicUser(updated ?? me) };
  });

  /** Live feedback while typing a handle, so claiming one is not trial and error. */
  app.get('/handles/:handle', { preHandler: requireUser }, async (req) => {
    const { handle } = req.params as { handle: string };
    const normalized = handle.trim().toLowerCase();
    const problem = handleProblem(normalized);
    if (problem) return { handle: normalized, available: false, reason: problem };
    const taken = await findUserByHandle(normalized);
    return taken
      ? { handle: normalized, available: false, reason: 'that handle is taken' }
      : { handle: normalized, available: true, url: `https://${normalized}.${env.baseDomain}` };
  });
}
