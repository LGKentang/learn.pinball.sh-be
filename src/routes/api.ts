import type { FastifyInstance } from 'fastify';
import * as q from '../db/queries.js';
import {
  addToAllowlist,
  freeSlug,
  listAllowlist,
  removeFromAllowlist,
  setPublished,
  slugify,
} from '../db/users.js';
import { requireAdmin, requireUser } from '../auth/session.js';
import { drillReviews, publishActions, questionsCreated, revisionsWritten } from '../metrics.js';
import { env } from '../env.js';
import {
  RATINGS,
  RELATION_KINDS,
  REVISION_KINDS,
  STATES,
  type Rating,
  type RelationKind,
  type RevisionKind,
  type State,
} from '../types.js';

const isState = (v: unknown): v is State => STATES.includes(v as State);
const isRating = (v: unknown): v is Rating => RATINGS.includes(v as Rating);
const isRelationKind = (v: unknown): v is RelationKind =>
  RELATION_KINDS.includes(v as RelationKind);
const isRevisionKind = (v: unknown): v is RevisionKind =>
  REVISION_KINDS.includes(v as RevisionKind);

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

export async function api(app: FastifyInstance) {
  // Everything below belongs to one learner. There is no unauthenticated route in
  // this file — the public read path is routes/public.ts, and it is separate on
  // purpose so a handler here can never accidentally be reachable without a session.
  app.addHook('preHandler', requireUser);

  /* ----------------------------------------------------------------- books */

  app.get('/books', async (req) => q.listBooks(req.user!.id));

  app.post('/books', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = text(body?.title);
    if (!title) return reply.code(400).send({ error: 'title is required' });
    return reply.code(201).send(await q.createBook(req.user!.id, title, text(body?.intent)));
  });

  app.get('/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const book = await q.getBook(me, id);
    if (!book) return reply.code(404).send({ error: 'not found' });
    const [tree, edges, stats] = await Promise.all([
      q.bookTree(me, id),
      q.bookEdges(me, id),
      q.bookStats(me, id),
    ]);
    return { book, tree, edges, stats };
  });

  app.patch('/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const patch: { title?: string; intent?: string | null } = {};
    if ('title' in body) {
      const t = text(body.title);
      if (!t) return reply.code(400).send({ error: 'title cannot be empty' });
      patch.title = t;
    }
    if ('intent' in body) patch.intent = text(body.intent);
    const updated = await q.updateBook(req.user!.id, id, patch);
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  app.delete('/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await q.deleteBook(req.user!.id, id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not found' });
  });

  /**
   * Publish or unpublish. A handle is required first: without one there is no
   * subdomain for the book to live on.
   */
  app.post('/books/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publish = body.published !== false;

    const book = await q.getBook(me.id, id);
    if (!book) return reply.code(404).send({ error: 'not found' });

    if (!publish) {
      const off = await setPublished(me.id, id, false, null);
      publishActions.inc({ action: 'unpublish' });
      req.log.info({ event: 'book_unpublished', bookId: id }, 'book unpublished');
      return { published: false, slug: off?.slug ?? null, url: null };
    }

    if (!me.handle)
      return reply.code(409).send({ error: 'claim a handle before publishing', need: 'handle' });
    if (!me.can_publish) return reply.code(403).send({ error: 'publishing is not enabled yet' });

    const requested = text(body.slug);
    const slug = requested
      ? slugify(requested)
      : (book.slug ?? (await freeSlug(me.id, book.title, id)));
    // Re-check for a clash: the requested slug may already belong to another book.
    const settled = requested ? await freeSlug(me.id, slug, id) : slug;

    const on = await setPublished(me.id, id, true, settled);
    if (!on) return reply.code(404).send({ error: 'not found' });
    publishActions.inc({ action: 'publish' });
    req.log.info({ event: 'book_published', bookId: id, slug: on.slug }, 'book published');
    return {
      published: true,
      slug: on.slug,
      published_at: on.published_at,
      url: `https://${me.handle}.${env.baseDomain}/${on.slug}`,
    };
  });

  /* ------------------------------------------------------------- questions */

  app.post('/questions', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = text(body?.title);
    const bookId = text(body?.book_id);
    if (!title) return reply.code(400).send({ error: 'title is required' });
    if (!bookId) return reply.code(400).send({ error: 'book_id is required' });
    const created = await q.createQuestion(req.user!.id, {
      book_id: bookId,
      parent_id: text(body?.parent_id),
      title,
    });
    // A book or parent that is missing and one that belongs to someone else are
    // the same answer on purpose: existence is not something to leak.
    if (!created) return reply.code(404).send({ error: 'book or parent question not found' });
    questionsCreated.inc();
    return reply.code(201).send(created);
  });

  /** Everything the Book view needs for one question, in one round trip. */
  app.get('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const question = await q.getQuestion(me, id);
    if (!question) return reply.code(404).send({ error: 'not found' });
    const [book, ancestors, children, relations, revisions, sources] = await Promise.all([
      q.getBook(me, question.book_id),
      q.ancestors(me, id),
      q.children(me, id),
      q.relations(me, id),
      q.revisions(me, id),
      q.sourcesFor(me, id),
    ]);
    return { question, book, ancestors, children, relations, revisions, sources };
  });

  app.patch('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const body = req.body as Record<string, unknown>;
    if (!(await q.getQuestion(me, id))) return reply.code(404).send({ error: 'not found' });

    if ('title' in body) {
      const t = text(body.title);
      if (!t) return reply.code(400).send({ error: 'title cannot be empty' });
      await q.renameQuestion(me, id, t);
    }
    if ('state' in body) {
      if (!isState(body.state)) return reply.code(400).send({ error: 'unknown state' });
      await q.setState(me, id, body.state);
    }
    if ('parked' in body) {
      await q.setParked(me, id, Boolean(body.parked), text(body.park_reason));
    }
    return (await q.getQuestion(me, id))!;
  });

  app.delete('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await q.deleteQuestion(req.user!.id, id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not found' });
  });

  /**
   * The only way to change an answer. Writes a revision every time — that history
   * is the Learning Trail.
   */
  app.post('/questions/:id/understanding', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const body = req.body as Record<string, unknown>;
    if (typeof body?.understanding !== 'string')
      return reply.code(400).send({ error: 'understanding is required' });
    const kind = body.kind;
    if (kind !== undefined && !isRevisionKind(kind))
      return reply.code(400).send({ error: 'unknown revision kind' });
    const result = await q.reviseUnderstanding(me, {
      question_id: id,
      understanding: body.understanding,
      kind,
      note: text(body.note),
      triggered_by_question_id: text(body.triggered_by_question_id),
    });
    if (!result) return reply.code(404).send({ error: 'not found' });
    revisionsWritten.inc({ kind: result.revision.kind });
    // A [[link]] the learner typed is a connection they made; let the graph follow.
    const linked = await q.syncWikilinks(me, id, body.understanding);
    return { ...result, linked };
  });

  /** Flat index of every question, for [[ ]] autocomplete and link resolution. */
  app.get('/questions', async (req) => q.questionIndex(req.user!.id));

  app.get('/questions/:id/trail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const question = await q.getQuestion(me, id);
    if (!question) return reply.code(404).send({ error: 'not found' });
    return { question, revisions: await q.revisions(me, id) };
  });

  /* ------------------------------------------------------------- relations */

  app.post('/relations', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!isRelationKind(body?.kind)) return reply.code(400).send({ error: 'unknown relation kind' });
    const from = text(body?.from_id);
    const to = text(body?.to_id);
    if (!from || !to) return reply.code(400).send({ error: 'from_id and to_id are required' });
    const me = req.user!.id;
    const res = await q.createRelation(me, {
      from_id: from,
      to_id: to,
      kind: body.kind,
      note: text(body.note),
    });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return reply.code(201).send({ relations: await q.relations(me, from) });
  });

  app.delete('/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await q.deleteRelation(req.user!.id, id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not found' });
  });

  /* ----------------------------------------------------------------- drill */

  app.get('/drill/due', async (req) => ({ questions: await q.dueQuestions(req.user!.id) }));

  app.post('/drill/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    if (!isRating(body?.rating)) return reply.code(400).send({ error: 'unknown rating' });
    const result = await q.submitReview(req.user!.id, {
      question_id: id,
      rating: body.rating,
      recalled: text(body.recalled),
    });
    if (!result) return reply.code(404).send({ error: 'not found' });
    drillReviews.inc({ rating: body.rating });
    return result;
  });

  /* ----------------------------------------------------------------- admin */

  app.get('/admin/allowlist', { preHandler: requireAdmin }, async () => ({
    entries: await listAllowlist(),
    from_env: env.allowlist,
  }));

  app.post('/admin/allowlist', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const email = text(body?.email)?.toLowerCase();
    if (!email || !/^@?[^@\s]+@?[^@\s]*$/.test(email))
      return reply.code(400).send({ error: 'an email address, or @domain.com, is required' });
    await addToAllowlist(email, text(body?.note));
    return reply.code(201).send({ entries: await listAllowlist() });
  });

  app.delete('/admin/allowlist/:email', { preHandler: requireAdmin }, async (req, reply) => {
    const { email } = req.params as { email: string };
    return (await removeFromAllowlist(decodeURIComponent(email)))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not found' });
  });
}
