/**
 * Demo data. Deliberately spans unrelated subjects — physics, economics, Japanese —
 * because domain independence is a product principle, not a nice-to-have.
 *
 *   npm run seed          reset and load
 */
import { count, newId, pool, row } from './index.js';
import * as q from './queries.js';
import { seedUser, SEED_EMAIL } from './seed-user.js';
import { nextReviewAt, type Rating, type State } from '../types.js';

const userId = await seedUser();

// Scoped to the seed's own account: every other table cascades from `book`, and
// wiping them outright would delete other people's work on a shared database.
await count('DELETE FROM book WHERE user_id = $1', [userId]);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

function ask(bookId: string, parentId: string | null, title: string) {
  return q.createQuestion(userId, { book_id: bookId, parent_id: parentId, title });
}

async function answer(
  id: string,
  understanding: string,
  opts: { kind?: 'initial' | 'refinement' | 'misconception_corrected'; note?: string; trigger?: string } = {},
) {
  await q.reviseUnderstanding(userId, {
    question_id: id,
    understanding,
    kind: opts.kind,
    note: opts.note ?? null,
    triggered_by_question_id: opts.trigger ?? null,
  });
}

async function mark(id: string, state: State, dueIn?: Rating) {
  await q.setState(userId, id, state);
  if (dueIn) {
    await count('UPDATE question SET next_review_at = $1 WHERE id = $2', [
      nextReviewAt(dueIn, new Date(daysAgo(30))),
      id,
    ]);
  }
}

/* ------------------------------------------------------------------ physics */

const physics = await q.createBook(userId, 
  'Understand how gravity works',
  'Be able to explain why objects of different mass fall at the same rate, and what that says about mass.',
);

const fall = await ask(physics!.id, null, 'Why do heavier objects not fall faster?');
await answer(
  fall!.id,
  'Heavier objects experience more gravity, so they should reach the ground first.',
  { kind: 'initial' },
);

const force = await ask(physics!.id, fall!.id, 'How much gravitational force acts on an object?');
await answer(force!.id, 'F = G·m₁·m₂/r². The force is proportional to the object’s mass.');
await mark(force!.id, 'understood', 'knew_it');

const inertia = await ask(physics!.id, fall!.id, 'What resists a change in motion?');
await answer(
  inertia!.id,
  'Inertia, and it is also proportional to mass. Doubling the mass doubles the force but also doubles the resistance to being accelerated.',
);
await mark(inertia!.id, 'can_explain', 'could_explain_deeply');

// The heart of the product: returning to the parent and correcting the model.
await answer(
  fall!.id,
  'Ignoring air resistance, gravitational acceleration is independent of mass. A heavier object does feel more gravitational force, but it also has proportionally more inertia, so the two cancel: a = F/m = G·M/r².',
  {
    kind: 'misconception_corrected',
    note: 'The original answer only counted the force and ignored inertia entirely.',
    trigger: inertia!.id,
  },
);
await mark(fall!.id, 'can_explain', 'partially_knew');

const airRes = await ask(physics!.id, fall!.id, 'So why does a feather fall slower than a hammer?');
await answer(airRes!.id, 'Air resistance, not gravity. In a vacuum they land together.');
await mark(airRes!.id, 'understood', 'knew_it');

const tides = await ask(physics!.id, null, 'Why does the Moon cause two tidal bulges, not one?');
await q.setParked(userId, tides!.id, true, 'Fascinating, but not needed to explain free fall — parked for later.');

const relativity = await ask(physics!.id, fall!.id, 'How does general relativity reframe all of this?');

/* ---------------------------------------------------------------- economics */

const econ = await q.createBook(userId, 
  'Understand inflation',
  'Understand enough economics to explain why central banks raise interest rates during inflation.',
);

const causes = await ask(econ!.id, null, 'What actually causes inflation?');
await answer(
  causes!.id,
  'Too much money chasing too few goods — but that phrasing hides at least two distinct mechanisms.',
);
await mark(causes!.id, 'understood', 'partially_knew');

const demandPull = await ask(econ!.id, causes!.id, 'What is demand-pull inflation?');
await answer(demandPull!.id, 'Demand outruns the economy’s capacity to supply, so prices rise.');
await mark(demandPull!.id, 'understood', 'knew_it');

const costPush = await ask(econ!.id, causes!.id, 'What is cost-push inflation?');
await answer(
  costPush!.id,
  'Input costs rise — energy, wages, shipping — and producers pass them on. Raising rates works far less well here, because the problem is supply, not demand.',
);
await mark(costPush!.id, 'can_explain', 'could_explain_deeply');

const rates = await ask(econ!.id, null, 'Why do central banks raise interest rates?');
await answer(
  rates!.id,
  'Higher rates make borrowing expensive and saving attractive, which cools demand. It is a demand-side lever, which is why it bites on demand-pull inflation and struggles with cost-push.',
  { note: 'Connected once cost-push made the asymmetry obvious.', trigger: costPush!.id },
);
await mark(rates!.id, 'can_explain', 'knew_it');

const cpi = await ask(econ!.id, null, 'How is inflation measured?');
await answer(cpi!.id, 'CPI: a weighted basket of goods tracked over time.');
await mark(cpi!.id, 'exploring', 'didnt_know');

const cpiFeel = await ask(econ!.id, cpi!.id, 'Why can CPI feel different from my own experience?');

const bonds = await ask(econ!.id, null, 'How do bond markets price expectations?');
await q.setParked(userId, bonds!.id, true, 'Rabbit hole. Interesting, but not required by the learning intent.');

/* ----------------------------------------------------------------- japanese */

const jp = await q.createBook(userId, 
  'Understand Japanese particles',
  'Be able to explain why a sentence uses は instead of が without guessing.',
);

const waGa = await ask(jp!.id, null, 'Why does this sentence use は instead of が?');
await answer(waGa!.id, 'は marks the subject and が is just a more formal alternative.', {
  kind: 'initial',
});

const topic = await ask(jp!.id, waGa!.id, 'What is a topic, as opposed to a subject?');
await answer(
  topic!.id,
  'The topic is what the sentence is about — often already known to both speakers. The subject is a grammatical role. They frequently differ.',
);
await mark(topic!.id, 'understood', 'knew_it');

await answer(
  waGa!.id,
  'は marks the topic (known, contrastive, "as for X"), が marks the grammatical subject and introduces new or identifying information. They are not interchangeable registers — they do different jobs.',
  {
    kind: 'misconception_corrected',
    note: 'The first answer conflated topic with subject and invented a formality difference that does not exist.',
    trigger: topic!.id,
  },
);
await mark(waGa!.id, 'understood', 'partially_knew');

const newInfo = await ask(jp!.id, waGa!.id, 'Why does が appear in answers to "who" questions?');

/* ------------------------------------- cross-book links (D6) and relations */

await q.createRelation(userId, {
  from_id: rates!.id,
  to_id: costPush!.id,
  kind: 'depends_on',
  note: 'Cannot explain why the lever underperforms without this.',
});
await q.createRelation(userId, { from_id: demandPull!.id, to_id: costPush!.id, kind: 'contradicts', note: 'Opposite mechanisms, opposite policy responses.' });
await q.createRelation(userId, { from_id: fall!.id, to_id: inertia!.id, kind: 'depends_on' });
await q.createRelation(userId, { from_id: airRes!.id, to_id: fall!.id, kind: 'example_of' });
// The point of the knowledge graph: a link that crosses subjects entirely.
await q.createRelation(userId, {
  from_id: topic!.id,
  to_id: causes!.id,
  kind: 'related_to',
  note: 'Both are cases where one everyday word hides two distinct mechanisms.',
});

/* ------------------------------------------------------------------ sources */

const srcId = newId();
await count(
  "INSERT INTO source (id, book_id, kind, title, locator) VALUES ($1,$2,'video',$3,$4)",
  [srcId, physics!.id, 'Hammer and feather on the Moon (Apollo 15)', 'https://example.org/apollo15'],
);
await count('INSERT INTO question_source (question_id, source_id, excerpt) VALUES ($1,$2,$3)', [
  airRes!.id,
  srcId,
  'Both objects strike the lunar surface simultaneously.',
]);

/* ------------------------------------------------ a little review history */

await q.submitReview(userId, { question_id: costPush!.id, rating: 'could_explain_deeply', recalled: 'Supply-side cost increases passed through to prices.' });
await q.submitReview(userId, { question_id: cpi!.id, rating: 'didnt_know' });

const counts = await row<{ n: number }>(
  'SELECT count(*) AS n FROM question q JOIN book b ON b.id = q.book_id WHERE b.user_id = $1',
  [userId],
);
const due = (await q.dueQuestions(userId, 99)).length;
console.log(
  `seeded for ${SEED_EMAIL}: 3 books, ${counts?.n ?? 0} questions, ${due} due for drill\n` +
    `        (parked: gravity/tides, economics/bonds — rabbit holes preserved, not deleted)`,
);

await pool.end();
