import Fastify from 'fastify';
import { api } from './routes/api.js';
import { uploads } from './routes/uploads.js';
import { DB_PATH } from './db/index.js';

const app = Fastify({ logger: { transport: undefined, level: 'info' } });

app.get('/health', async () => ({ ok: true, db: DB_PATH }));
app.register(api, { prefix: '/api' });
app.register(uploads, { prefix: '/api' });

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

app
  .listen({ port, host })
  .then(() => app.log.info(`pinball api on http://${host}:${port}  db=${DB_PATH}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
