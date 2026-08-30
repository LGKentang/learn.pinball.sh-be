import type { FastifyInstance } from 'fastify';
import { images, IMAGE_TYPES, MAX_BYTES, SAFE_NAME, typeFor } from '../storage.js';
import { requireUser } from '../auth/session.js';
import { count, row } from '../db/index.js';

export async function uploads(app: FastifyInstance) {
  // Raw bytes rather than multipart: the clipboard hands us a Blob, so a plain
  // body carrying the image's own content-type is the whole protocol.
  app.addContentTypeParser(
    Object.keys(IMAGE_TYPES),
    { parseAs: 'buffer', bodyLimit: MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  /** Uploading costs storage, so it needs an account. Reading does not (D13). */
  app.post('/uploads', { bodyLimit: MAX_BYTES, preHandler: requireUser }, async (req, reply) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return reply.code(415).send({ error: `unsupported image type: ${type || 'none'}` });

    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length)
      return reply.code(400).send({ error: 'empty upload' });
    if (body.length > MAX_BYTES) return reply.code(413).send({ error: 'image is larger than 8MB' });

    const name = await images.put(body, ext, type);
    await count(
      'INSERT INTO upload (name, user_id, bytes, content_type) VALUES ($1,$2,$3,$4)',
      [name, req.user!.id, body.length, type],
    );
    return reply.code(201).send({ url: `/api/uploads/${name}`, bytes: body.length });
  });

  /**
   * Public read. The 128-bit random name is the capability; there is no session
   * check here because published pages have to load these from another origin and
   * from other people's browsers.
   */
  app.get('/uploads/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SAFE_NAME.test(name)) return reply.code(400).send({ error: 'bad name' });

    // With S3 behind a CDN the bytes never touch this process: hand the browser
    // the CDN URL and let it cache there.
    const direct = images.publicUrl(name);
    if (direct) {
      return reply
        .header('cache-control', 'public, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .redirect(direct, 302);
    }

    const file = await images.read(name);
    if (!file) return reply.code(404).send({ error: 'not found' });

    return reply
      .header('content-type', typeFor(name))
      .header('content-length', file.size)
      // names are content-addressed by randomness, so they never change meaning
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('access-control-allow-origin', '*')
      .send(file.stream);
  });

  /** Removing an image is the owner's call; the row is what proves ownership. */
  app.delete('/uploads/:name', { preHandler: requireUser }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SAFE_NAME.test(name)) return reply.code(400).send({ error: 'bad name' });
    const mine = await row<{ name: string }>(
      'SELECT name FROM upload WHERE name = $1 AND user_id = $2',
      [name, req.user!.id],
    );
    if (!mine) return reply.code(404).send({ error: 'not found' });
    await images.remove(name);
    await count('DELETE FROM upload WHERE name = $1', [name]);
    return reply.code(204).send();
  });
}
