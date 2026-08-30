/** `npm run migrate` — apply pending migrations and exit. */
import { migrate, pool } from './index.js';

await migrate();
console.log('migrations up to date');
await pool.end();
