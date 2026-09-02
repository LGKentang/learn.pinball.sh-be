/**
 * Prometheus metrics, scraped at GET /metrics.
 *
 * Every label here is a closed, bounded set — a state enum, a rating, a storage
 * driver, a matched route *pattern* — never a raw id or free-text string. That is
 * not a style preference: a label with unbounded cardinality (a user id, a book
 * title, a raw URL) is how a scrape turns into a new time series per request and
 * eventually falls over the TSDB. High-cardinality detail belongs in the
 * structured logs (see server.ts's logger config), not here.
 *
 * This endpoint is deliberately unauthenticated, the way Prometheus expects to
 * scrape — do not put it behind requireUser. What keeps it private is that it is
 * never proxied on the public path: nginx's APP_HOST server block only forwards
 * /api/, and the default (published-sites) block proxies to the backend but this
 * route only exists on /metrics at the root, which nothing routes to it publicly.
 * Scrape it container-to-container, the same way Postgres is only reachable on
 * the `internal` compose network.
 */
// The Prometheus org's own client, and the one prom-client's own README now
// points people at — same API, actively maintained under github.com/prometheus.
import client from '@prometheus-io/client';
import type { FastifyInstance } from 'fastify';
import { pool } from './db/index.js';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

/* ---------------------------------------------------------------------- http */

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests received, by method, matched route and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method, matched route and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Tuned for an interactive API: sub-10ms reads up through a slow S3 round trip.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** Registers the onResponse hook that fills in the two metrics above. */
export function httpMetricsPlugin(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    // req.routeOptions.url is the *pattern* ("/books/:id"), not the requested URL —
    // that is the entire cardinality guarantee. A request that matched no route
    // (a 404, or someone probing random paths) is grouped under one label instead
    // of minting a new series per garbage path.
    const route = req.is404 ? 'unmatched' : (req.routeOptions.url ?? 'unmatched');
    const labels = { method: req.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });
}

/* ----------------------------------------------------------------- pg pool */

// eslint-disable-next-line no-new -- registers itself via `registers`; nothing to hold onto
new client.Gauge({
  name: 'pg_pool_connections',
  help: 'Postgres connection pool state',
  labelNames: ['state'] as const,
  registers: [register],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

/* ------------------------------------------------------------- product activity */

/**
 * Sign-in outcomes. `result` is one of a fixed set of reasons routes/auth.ts
 * already produces for the redirect (state_mismatch, missing_code,
 * exchange_failed, not_allowed, unverified_email) plus 'success' and
 * 'google_error' — the last absorbs whatever string Google's own `error` query
 * param carries, which is not something we control the shape of and therefore
 * never belongs directly on a label.
 */
export const authSignins = new client.Counter({
  name: 'pinball_auth_signins_total',
  help: 'Sign-in attempts, by outcome',
  labelNames: ['result'] as const,
  registers: [register],
});

export const uploads = new client.Counter({
  name: 'pinball_uploads_total',
  help: 'Image uploads accepted, by storage driver',
  labelNames: ['storage'] as const,
  registers: [register],
});

export const uploadBytes = new client.Counter({
  name: 'pinball_upload_bytes_total',
  help: 'Bytes accepted by image uploads, by storage driver',
  labelNames: ['storage'] as const,
  registers: [register],
});

export const publishActions = new client.Counter({
  name: 'pinball_publish_actions_total',
  help: 'Book publish/unpublish actions',
  labelNames: ['action'] as const,
  registers: [register],
});

export const questionsCreated = new client.Counter({
  name: 'pinball_questions_created_total',
  help: 'Questions created',
  registers: [register],
});

export const revisionsWritten = new client.Counter({
  name: 'pinball_revisions_total',
  help: 'Understanding revisions written, by kind',
  labelNames: ['kind'] as const,
  registers: [register],
});

export const drillReviews = new client.Counter({
  name: 'pinball_drill_reviews_total',
  help: 'Drill reviews submitted, by rating',
  labelNames: ['rating'] as const,
  registers: [register],
});

/** Registers GET /metrics. Call once, unauthenticated, outside any prefix. */
export function metricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', register.contentType);
    return register.metrics();
  });
}
