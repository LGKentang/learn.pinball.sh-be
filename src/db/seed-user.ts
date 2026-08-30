/**
 * The account the seeds belong to.
 *
 * Books have owners now, so a seed needs one. It reuses PINBALL_BOOTSTRAP_EMAIL
 * when that is set — running `npm run seed` then fills the account you will
 * actually sign in to — and falls back to a demo address otherwise.
 */
import { migrate } from './index.js';
import { addToAllowlist, createUser, findUserByEmail } from './users.js';
import { env } from '../env.js';

export const SEED_EMAIL = env.bootstrapEmail || 'demo@pinball.sh';

export async function seedUser(): Promise<string> {
  await migrate(() => undefined);
  const existing = await findUserByEmail(SEED_EMAIL);
  if (existing) return existing.id;

  // Seeding an address implies it is allowed to sign in later.
  await addToAllowlist(SEED_EMAIL, 'created by a seed');
  const created = await createUser({
    email: SEED_EMAIL,
    name: env.bootstrapEmail ? null : 'Demo Learner',
    is_admin: true,
  });
  if (!created) throw new Error(`could not create the seed user ${SEED_EMAIL}`);
  return created.id;
}
