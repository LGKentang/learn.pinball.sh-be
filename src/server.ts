import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { api } from './routes/api.js';
import { auth } from './routes/auth.js';
import { uploads } from './routes/uploads.js';
import { publicSite } from './routes/public.js';
import { sessionPlugin } from './auth/session.js';
import { migrate, pool } from './db/index.js';
import { purgeExpiredSessions } from './db/users.js';
import { assertBootable, env, isProduction } from './env.js';

assertBootable();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Cloudflare and nginx both sit in front in production. Without this, every
  // request looks like it came from the proxy and req.protocol is always http.
  trustProxy: true,
});

await app.register(cookie, { secret: env.sessionSecret });
sessionPlugin(app);

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true, storage: env.storage, domain: env.baseDomain };
});

await app.register(auth, { prefix: '/api' });
await app.register(api, { prefix: '/api' });
await app.register(uploads, { prefix: '/api' });

/**
 * Published sites. These sit at the root because a tenant subdomain is proxied
 * here whole; `handleFromHost` returns null for the app's own host, so hitting
 * the backend's root directly renders a 404 page rather than someone's notes.
 */
await app.register(publicSite);

await migrate((m) => app.log.info(m));

// Sessions expire in the database, but the rows should not pile up forever.
const purge = setInterval(
  () => {
    void purgeExpiredSessions().catch((err) => app.log.warn({ err }, 'session purge failed'));
  },
  6 * 60 * 60 * 1000,
);
purge.unref();

async function shutdown(signal: string) {
  app.log.info(`${signal} received, closing`);
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.port, host: env.host });
  app.log.info(
    `pinball api on http://${env.host}:${env.port}  ` +
      `app=${env.appOrigin}  sites=*.${env.baseDomain}  storage=${env.storage}`,
  );
  if (!env.googleConfigured && !isProduction)
    app.log.warn('GOOGLE_CLIENT_ID/SECRET are unset — use PINBALL_DEV_LOGIN to sign in locally');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
