import Fastify from 'fastify';
import { api } from './routes/api.js';
import { uploads } from './routes/uploads.js';
import { DB_PATH } from './db/index.js';

const app = Fastify({ logger: { transport: undefined, level: 'info' } });

app.get('/health', async () => ({ ok: true, db: DB_PATH }));
app.register(api, { prefix: '/api' });
app.register(uploads, { prefix: '/api' });

const port = Number(process.env.PORT ?? 8787);

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => app.log.info(`pinball api on http://127.0.0.1:${port}  db=${DB_PATH}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
