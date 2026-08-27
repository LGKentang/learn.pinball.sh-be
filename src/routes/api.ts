import type { FastifyInstance } from 'fastify';
import * as q from '../db/queries.js';
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
  /* ----------------------------------------------------------------- books */

  app.get('/books', async () => q.listBooks());

  app.post('/books', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = text(body?.title);
    if (!title) return reply.code(400).send({ error: 'title is required' });
    return reply.code(201).send(q.createBook(title, text(body?.intent)));
  });

  app.get('/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = q.getBook(id);
    if (!book) return reply.code(404).send({ error: 'not found' });
    return {
      book,
      tree: q.bookTree(id),
      edges: q.bookEdges(id),
      stats: q.bookStats(id),
    };
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
    const updated = q.updateBook(id, patch);
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  app.delete('/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return q.deleteBook(id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  /* ------------------------------------------------------------- questions */

  app.post('/questions', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = text(body?.title);
    const bookId = text(body?.book_id);
    if (!title) return reply.code(400).send({ error: 'title is required' });
    if (!bookId) return reply.code(400).send({ error: 'book_id is required' });
    if (!q.getBook(bookId)) return reply.code(404).send({ error: 'book not found' });
    const parentId = text(body?.parent_id);
    if (parentId && !q.getQuestion(parentId))
      return reply.code(404).send({ error: 'parent question not found' });
    return reply.code(201).send(q.createQuestion({ book_id: bookId, parent_id: parentId, title }));
  });

  /** Everything the Book view needs for one question, in one round trip. */
  app.get('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const question = q.getQuestion(id);
    if (!question) return reply.code(404).send({ error: 'not found' });
    return {
      question,
      book: q.getBook(question.book_id),
      ancestors: q.ancestors(id),
      children: q.children(id),
      relations: q.relations(id),
      revisions: q.revisions(id),
      sources: q.sourcesFor(id),
    };
  });

  app.patch('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    if (!q.getQuestion(id)) return reply.code(404).send({ error: 'not found' });

    if ('title' in body) {
      const t = text(body.title);
      if (!t) return reply.code(400).send({ error: 'title cannot be empty' });
      q.renameQuestion(id, t);
    }
    if ('state' in body) {
      if (!isState(body.state)) return reply.code(400).send({ error: 'unknown state' });
      q.setState(id, body.state);
    }
    if ('parked' in body) {
      q.setParked(id, Boolean(body.parked), text(body.park_reason));
    }
    return q.getQuestion(id)!;
  });

  app.delete('/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return q.deleteQuestion(id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  /**
   * The only way to change an answer. Writes a revision every time — that history
   * is the Learning Trail.
   */
  app.post('/questions/:id/understanding', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    if (typeof body?.understanding !== 'string')
      return reply.code(400).send({ error: 'understanding is required' });
    const kind = body.kind;
    if (kind !== undefined && !isRevisionKind(kind))
      return reply.code(400).send({ error: 'unknown revision kind' });
    const result = q.reviseUnderstanding({
      question_id: id,
      understanding: body.understanding,
      kind,
      note: text(body.note),
      triggered_by_question_id: text(body.triggered_by_question_id),
    });
    if (!result) return reply.code(404).send({ error: 'not found' });
    // A [[link]] the learner typed is a connection they made; let the graph follow.
    const linked = q.syncWikilinks(id, body.understanding);
    return { ...result, linked };
  });

  /** Flat index of every question, for [[ ]] autocomplete and link resolution. */
  app.get('/questions', async () => q.questionIndex());

  app.get('/questions/:id/trail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const question = q.getQuestion(id);
    if (!question) return reply.code(404).send({ error: 'not found' });
    return { question, revisions: q.revisions(id) };
  });

  /* ------------------------------------------------------------- relations */

  app.post('/relations', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!isRelationKind(body?.kind)) return reply.code(400).send({ error: 'unknown relation kind' });
    const from = text(body?.from_id);
    const to = text(body?.to_id);
    if (!from || !to) return reply.code(400).send({ error: 'from_id and to_id are required' });
    const res = q.createRelation({ from_id: from, to_id: to, kind: body.kind, note: text(body.note) });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return reply.code(201).send({ relations: q.relations(from) });
  });

  app.delete('/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return q.deleteRelation(id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  /* ----------------------------------------------------------------- drill */

  app.get('/drill/due', async () => ({ questions: q.dueQuestions() }));

  app.post('/drill/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    if (!isRating(body?.rating)) return reply.code(400).send({ error: 'unknown rating' });
    const result = q.submitReview({
      question_id: id,
      rating: body.rating,
      recalled: text(body.recalled),
    });
    return result ?? reply.code(404).send({ error: 'not found' });
  });
}
