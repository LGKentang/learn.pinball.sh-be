import type { FastifyInstance } from 'fastify';
import { images, IMAGE_TYPES, MAX_BYTES, SAFE_NAME, typeFor } from '../storage.js';

export async function uploads(app: FastifyInstance) {
  // Raw bytes rather than multipart: the clipboard hands us a Blob, so a plain
  // body carrying the image's own content-type is the whole protocol.
  app.addContentTypeParser(
    Object.keys(IMAGE_TYPES),
    { parseAs: 'buffer', bodyLimit: MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post('/uploads', { bodyLimit: MAX_BYTES }, async (req, reply) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return reply.code(415).send({ error: `unsupported image type: ${type || 'none'}` });

    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length)
      return reply.code(400).send({ error: 'empty upload' });
    if (body.length > MAX_BYTES) return reply.code(413).send({ error: 'image is larger than 8MB' });

    const name = await images.put(body, ext);
    return reply.code(201).send({ url: `/api/uploads/${name}`, bytes: body.length });
  });

  app.get('/uploads/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SAFE_NAME.test(name)) return reply.code(400).send({ error: 'bad name' });

    const file = await images.read(name);
    if (!file) return reply.code(404).send({ error: 'not found' });

    return reply
      .header('content-type', typeFor(name))
      .header('content-length', file.size)
      // names are content-addressed by randomness, so they never change meaning
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(file.stream);
  });
}
