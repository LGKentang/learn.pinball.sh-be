/**
 * Demo data. Deliberately spans unrelated subjects — physics, economics, Japanese —
 * because domain independence is a product principle, not a nice-to-have.
 *
 *   npm run seed          reset and load
 */
import { db, newId, now } from './index.js';
import * as q from './queries.js';
import { nextReviewAt, type Rating, type State } from '../types.js';

for (const t of [
  'question_source',
  'source',
  'review',
  'revision',
  'question_relation',
  'question',
  'book',
]) {
  db.exec(`DELETE FROM ${t}`);
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

function ask(bookId: string, parentId: string | null, title: string) {
  return q.createQuestion({ book_id: bookId, parent_id: parentId, title });
}

function answer(
  id: string,
  understanding: string,
  opts: { kind?: 'initial' | 'refinement' | 'misconception_corrected'; note?: string; trigger?: string } = {},
) {
  q.reviseUnderstanding({
    question_id: id,
    understanding,
    kind: opts.kind,
    note: opts.note ?? null,
    triggered_by_question_id: opts.trigger ?? null,
  });
}

function mark(id: string, state: State, dueIn?: Rating) {
  q.setState(id, state);
  if (dueIn) {
    db.prepare('UPDATE question SET next_review_at = ? WHERE id = ?').run(
      nextReviewAt(dueIn, new Date(daysAgo(30))),
      id,
    );
  }
}

/* ------------------------------------------------------------------ physics */

const physics = q.createBook(
  'Understand how gravity works',
  'Be able to explain why objects of different mass fall at the same rate, and what that says about mass.',
);

const fall = ask(physics.id, null, 'Why do heavier objects not fall faster?');
answer(
  fall.id,
  'Heavier objects experience more gravity, so they should reach the ground first.',
  { kind: 'initial' },
);

const force = ask(physics.id, fall.id, 'How much gravitational force acts on an object?');
answer(force.id, 'F = G·m₁·m₂/r². The force is proportional to the object’s mass.');
mark(force.id, 'understood', 'knew_it');

const inertia = ask(physics.id, fall.id, 'What resists a change in motion?');
answer(
  inertia.id,
  'Inertia, and it is also proportional to mass. Doubling the mass doubles the force but also doubles the resistance to being accelerated.',
);
mark(inertia.id, 'can_explain', 'could_explain_deeply');

// The heart of the product: returning to the parent and correcting the model.
answer(
  fall.id,
  'Ignoring air resistance, gravitational acceleration is independent of mass. A heavier object does feel more gravitational force, but it also has proportionally more inertia, so the two cancel: a = F/m = G·M/r².',
  {
    kind: 'misconception_corrected',
    note: 'The original answer only counted the force and ignored inertia entirely.',
    trigger: inertia.id,
  },
);
mark(fall.id, 'can_explain', 'partially_knew');

const airRes = ask(physics.id, fall.id, 'So why does a feather fall slower than a hammer?');
answer(airRes.id, 'Air resistance, not gravity. In a vacuum they land together.');
mark(airRes.id, 'understood', 'knew_it');

const tides = ask(physics.id, null, 'Why does the Moon cause two tidal bulges, not one?');
q.setParked(tides.id, true, 'Fascinating, but not needed to explain free fall — parked for later.');

const relativity = ask(physics.id, fall.id, 'How does general relativity reframe all of this?');

/* ---------------------------------------------------------------- economics */

const econ = q.createBook(
  'Understand inflation',
  'Understand enough economics to explain why central banks raise interest rates during inflation.',
);

const causes = ask(econ.id, null, 'What actually causes inflation?');
answer(
  causes.id,
  'Too much money chasing too few goods — but that phrasing hides at least two distinct mechanisms.',
);
mark(causes.id, 'understood', 'partially_knew');

const demandPull = ask(econ.id, causes.id, 'What is demand-pull inflation?');
answer(demandPull.id, 'Demand outruns the economy’s capacity to supply, so prices rise.');
mark(demandPull.id, 'understood', 'knew_it');

const costPush = ask(econ.id, causes.id, 'What is cost-push inflation?');
answer(
  costPush.id,
  'Input costs rise — energy, wages, shipping — and producers pass them on. Raising rates works far less well here, because the problem is supply, not demand.',
);
mark(costPush.id, 'can_explain', 'could_explain_deeply');

const rates = ask(econ.id, null, 'Why do central banks raise interest rates?');
answer(
  rates.id,
  'Higher rates make borrowing expensive and saving attractive, which cools demand. It is a demand-side lever, which is why it bites on demand-pull inflation and struggles with cost-push.',
  { note: 'Connected once cost-push made the asymmetry obvious.', trigger: costPush.id },
);
mark(rates.id, 'can_explain', 'knew_it');

const cpi = ask(econ.id, null, 'How is inflation measured?');
answer(cpi.id, 'CPI: a weighted basket of goods tracked over time.');
mark(cpi.id, 'exploring', 'didnt_know');

const cpiFeel = ask(econ.id, cpi.id, 'Why can CPI feel different from my own experience?');

const bonds = ask(econ.id, null, 'How do bond markets price expectations?');
q.setParked(bonds.id, true, 'Rabbit hole. Interesting, but not required by the learning intent.');

/* ----------------------------------------------------------------- japanese */

const jp = q.createBook(
  'Understand Japanese particles',
  'Be able to explain why a sentence uses は instead of が without guessing.',
);

const waGa = ask(jp.id, null, 'Why does this sentence use は instead of が?');
answer(waGa.id, 'は marks the subject and が is just a more formal alternative.', {
  kind: 'initial',
});

const topic = ask(jp.id, waGa.id, 'What is a topic, as opposed to a subject?');
answer(
  topic.id,
  'The topic is what the sentence is about — often already known to both speakers. The subject is a grammatical role. They frequently differ.',
);
mark(topic.id, 'understood', 'knew_it');

answer(
  waGa.id,
  'は marks the topic (known, contrastive, "as for X"), が marks the grammatical subject and introduces new or identifying information. They are not interchangeable registers — they do different jobs.',
  {
    kind: 'misconception_corrected',
    note: 'The first answer conflated topic with subject and invented a formality difference that does not exist.',
    trigger: topic.id,
  },
);
mark(waGa.id, 'understood', 'partially_knew');

const newInfo = ask(jp.id, waGa.id, 'Why does が appear in answers to "who" questions?');

/* ------------------------------------- cross-book links (D6) and relations */

q.createRelation({
  from_id: rates.id,
  to_id: costPush.id,
  kind: 'depends_on',
  note: 'Cannot explain why the lever underperforms without this.',
});
q.createRelation({ from_id: demandPull.id, to_id: costPush.id, kind: 'contradicts', note: 'Opposite mechanisms, opposite policy responses.' });
q.createRelation({ from_id: fall.id, to_id: inertia.id, kind: 'depends_on' });
q.createRelation({ from_id: airRes.id, to_id: fall.id, kind: 'example_of' });
// The point of the knowledge graph: a link that crosses subjects entirely.
q.createRelation({
  from_id: topic.id,
  to_id: causes.id,
  kind: 'related_to',
  note: 'Both are cases where one everyday word hides two distinct mechanisms.',
});

/* ------------------------------------------------------------------ sources */

const srcId = newId();
db.prepare(
  'INSERT INTO source (id, book_id, kind, title, locator, created_at) VALUES (?,?,?,?,?,?)',
).run(srcId, physics.id, 'video', 'Hammer and feather on the Moon (Apollo 15)', 'https://example.org/apollo15', now());
db.prepare('INSERT INTO question_source (question_id, source_id, excerpt) VALUES (?,?,?)').run(
  airRes.id,
  srcId,
  'Both objects strike the lunar surface simultaneously.',
);

/* ------------------------------------------------ a little review history */

q.submitReview({ question_id: costPush.id, rating: 'could_explain_deeply', recalled: 'Supply-side cost increases passed through to prices.' });
q.submitReview({ question_id: cpi.id, rating: 'didnt_know' });

const counts = db.prepare('SELECT count(*) AS n FROM question').get() as { n: number };
const due = q.dueQuestions().length;
console.log(
  `seeded: 3 books, ${counts.n} questions, ${due} due for drill\n` +
    `        (parked: gravity/tides, economics/bonds — rabbit holes preserved, not deleted)`,
);
