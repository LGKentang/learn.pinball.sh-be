/**
 * Kubernetes books. Additive — leaves everything else in the database alone, and
 * re-running replaces only the topics it owns, so it is safe to run repeatedly.
 *
 *   npm run seed:k8s
 */
import { db, newId, now } from './index.js';
import * as q from './queries.js';
import { nextReviewAt, type Rating, type State } from '../types.js';

const TOPICS = [
  'Understand Kubernetes health checks',
  'Understand why a pod will not schedule',
  'Understand Kubernetes Services',
];

// Replace only what this seed owns.
for (const title of TOPICS) {
  const existing = db.prepare('SELECT id FROM book WHERE title = ?').all(title) as {
    id: string;
  }[];
  for (const b of existing) q.deleteBook(b.id);
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

const ask = (book: string, parent: string | null, title: string) =>
  q.createQuestion({ book_id: book, parent_id: parent, title });

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
  // [[links]] the text uses become relations, the same as they would in the app
  q.syncWikilinks(id, understanding);
}

function mark(id: string, state: State, due?: Rating) {
  q.setState(id, state);
  if (due) {
    db.prepare('UPDATE question SET next_review_at = ? WHERE id = ?').run(
      nextReviewAt(due, new Date(daysAgo(40))),
      id,
    );
  }
}

function source(book: string, questionId: string, title: string, url: string, excerpt: string) {
  const id = newId();
  db.prepare(
    'INSERT INTO source (id, book_id, kind, title, locator, created_at) VALUES (?,?,?,?,?,?)',
  ).run(id, book, 'website', title, url, now());
  db.prepare('INSERT INTO question_source (question_id, source_id, excerpt) VALUES (?,?,?)').run(
    questionId,
    id,
    excerpt,
  );
}

/* ------------------------------------------------------------ health checks */

const health = q.createBook(
  TOPICS[0],
  'Be able to explain what happens to traffic when a pod is unhealthy, and choose the right probe without guessing.',
);

const why = ask(health.id, null, 'Why does Kubernetes need readiness probes?');
answer(
  why.id,
  'A pod that is running is ready to serve traffic. The probe just double-checks the process is alive.',
  { kind: 'initial' },
);

const traffic = ask(health.id, why.id, 'What happens to traffic when a pod is not ready?');
answer(
  traffic.id,
  'The pod is **removed from the Service endpoints**, so kube-proxy stops sending it new connections. The container keeps running — nothing is restarted, it is simply taken out of rotation.\n\nSee [[What is an EndpointSlice?]] for where that list actually lives.',
);
mark(traffic.id, 'can_explain', 'could_explain_deeply');

const slice = ask(health.id, traffic.id, 'What is an EndpointSlice?');
answer(
  slice.id,
  'The object holding the set of pod IPs backing a Service. The endpoints controller adds and removes pods as their readiness changes; `kube-proxy` watches it and rewrites its rules.\n\nEndpointSlice replaced the older single `Endpoints` object, which did not scale past a few thousand pods.',
);
mark(slice.id, 'understood', 'knew_it');

const vsLiveness = ask(health.id, why.id, 'How is a readiness probe different from a liveness probe?');
answer(
  vsLiveness.id,
  'Different failure responses:\n\n- **readiness** fails → pod leaves the Service endpoints, keeps running\n- **liveness** fails → kubelet **restarts the container**\n\nThey answer different questions: *can this serve traffic right now* versus *is this process wedged and beyond recovery*.',
);
mark(vsLiveness.id, 'can_explain', 'knew_it');

const livenessFails = ask(health.id, vsLiveness.id, 'What does Kubernetes do when a liveness probe fails?');
answer(
  livenessFails.id,
  'The kubelet kills the container and restarts it under the pod\'s `restartPolicy`, backing off exponentially. The pod keeps its name and IP — it is the *container* that restarts, not the pod.\n\nA liveness probe pointed at a slow dependency is how you turn a slow service into a restart loop.',
);
mark(livenessFails.id, 'understood', 'partially_knew');

// The point of the product: going back and fixing the original answer.
answer(
  why.id,
  'Running and ready are **not** the same state. A process can be up but still loading caches, waiting on a migration, or warming a connection pool — serving it traffic returns errors.\n\nA readiness probe gates **membership of the Service endpoints**, so traffic only reaches pods that can actually answer. It never restarts anything; that is what [[How is a readiness probe different from a liveness probe?]] covers.',
  {
    kind: 'misconception_corrected',
    note: 'The first answer conflated "running" with "ready", and assumed probes restart things. Only liveness does that.',
    trigger: vsLiveness.id,
  },
);
mark(why.id, 'can_explain', 'partially_knew');

const startup = ask(health.id, why.id, 'What is a startup probe for?');
answer(
  startup.id,
  'It suspends the liveness probe until the app has finished starting. Without it, a slow-booting app gets killed by liveness before it ever comes up — and restarts forever.',
);
mark(startup.id, 'understood', 'knew_it');

const gate = ask(health.id, why.id, 'What are readiness gates, and when would I need one?');

source(
  health.id,
  traffic.id,
  'Kubernetes docs — Configure Liveness, Readiness and Startup Probes',
  'https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/',
  'The kubelet uses readiness probes to know when a container is ready to start accepting traffic.',
);

/* -------------------------------------------------------------- scheduling */

const sched = q.createBook(
  TOPICS[1],
  'Be able to look at a Pending pod and say exactly which constraint is unsatisfied.',
);

const pending = ask(sched.id, null, 'Why is my pod stuck in Pending?');
answer(
  pending.id,
  'Pending means **no node has been assigned yet**. The scheduler looked and found nothing that fits, or it has not looked yet.\n\n`kubectl describe pod` lists the reason per node — that message is the answer, not a hint.',
);
mark(pending.id, 'understood', 'partially_knew');

const decides = ask(sched.id, pending.id, 'What does the scheduler actually decide?');
answer(
  decides.id,
  'Two phases:\n\n1. **Filtering** — which nodes *could* run this pod (resources, taints, affinity, volumes)\n2. **Scoring** — of those, which is best\n\nIf filtering leaves zero nodes, the pod stays Pending.',
);
mark(decides.id, 'can_explain', 'knew_it');

const requests = ask(sched.id, pending.id, 'What are requests and limits?');
answer(
  requests.id,
  '**Requests** are what the scheduler reserves — the number it does arithmetic with. **Limits** are the ceiling the runtime enforces at execution time.\n\nOnly requests affect whether a pod schedules. A cluster can be 20% utilised and still refuse a pod because requests are all spoken for.',
);
mark(requests.id, 'can_explain', 'could_explain_deeply');

const oom = ask(sched.id, requests.id, 'What happens when a container exceeds its memory limit?');
answer(
  oom.id,
  'The kernel OOM-kills it and the container restarts — `OOMKilled`, exit code 137. Memory is incompressible: there is no way to give a process less of it than it is asking for right now.',
);
mark(oom.id, 'understood', 'knew_it');

const cpu = ask(sched.id, requests.id, 'What happens when a container exceeds its CPU limit?');
answer(
  cpu.id,
  'It gets **throttled**, not killed. CFS gives it less time per period and it runs slower.\n\nThis is why CPU limits are argued about: the symptom is latency, not a crash, so it is much harder to spot than [[What happens when a container exceeds its memory limit?]].',
);
mark(cpu.id, 'can_explain', 'could_explain_deeply');

const taints = ask(sched.id, pending.id, 'What are taints and tolerations?');
answer(
  taints.id,
  'A **taint** on a node repels pods; a **toleration** on a pod says it will put up with a given taint. Used to keep general workloads off special nodes — control plane, GPU, spot instances.\n\nNote the polarity: a toleration lets a pod schedule there, it does not attract it.',
);
mark(taints.id, 'understood', 'partially_knew');

const affinity = ask(sched.id, pending.id, 'How does affinity differ from a nodeSelector?');
answer(affinity.id, 'nodeSelector is a hard equality match. Affinity adds soft preferences and richer operators.');
mark(affinity.id, 'exploring', 'didnt_know');

const topology = ask(sched.id, pending.id, 'How does topology spread constraint scoring work in detail?');
q.setParked(topology.id, true, 'Deep in the weeds. Not needed to diagnose a Pending pod — parked.');

const pdb = ask(sched.id, null, 'Why did a drain hang instead of evicting my pod?');

/* ----------------------------------------------------------------- services */

const svc = q.createBook(
  TOPICS[2],
  'Be able to explain what a Service actually is at the packet level, not just what it is for.',
);

const needSvc = ask(svc.id, null, 'Why do I need a Service if pods already have IPs?');
answer(
  needSvc.id,
  'A Service is a stable name and virtual IP in front of a set that changes. Pod IPs are ephemeral — every rollout, crash or scale event hands out new ones.\n\nMembership of that set is exactly what readiness controls: see [[What happens to traffic when a pod is not ready?]].',
);
mark(needSvc.id, 'can_explain', 'knew_it');

const kubeProxy = ask(svc.id, needSvc.id, 'What is kube-proxy actually doing?');
answer(
  kubeProxy.id,
  'Nothing is proxying in the normal sense. kube-proxy programs **iptables or IPVS rules** on every node that DNAT a packet addressed to the ClusterIP to one of the backing pod IPs.\n\nThe balancing is a kernel-level rule, not a userspace hop.',
);
mark(kubeProxy.id, 'understood', 'partially_knew');

const clusterIp = ask(svc.id, needSvc.id, 'What is the difference between ClusterIP, NodePort and LoadBalancer?');
answer(
  clusterIp.id,
  'They stack:\n\n- **ClusterIP** — reachable inside the cluster only\n- **NodePort** — ClusterIP *plus* a port opened on every node\n- **LoadBalancer** — NodePort *plus* a cloud load balancer pointed at it\n\nEach is the previous one with something added, which is why a LoadBalancer Service still has a ClusterIP.',
);
mark(clusterIp.id, 'understood', 'knew_it');

const dns = ask(svc.id, needSvc.id, 'Does Service DNS do the load balancing?');
answer(dns.id, 'DNS round-robins between the pod IPs, and clients cache the first one they get.', {
  kind: 'initial',
});
answer(
  dns.id,
  'No. For a normal Service, DNS returns **one** address — the ClusterIP — and the balancing happens in the kernel rules that [[What is kube-proxy actually doing?]] describes.\n\nDNS round-robin only applies to *headless* Services (`clusterIP: None`), where the record lists the pod IPs directly. That is the case where client-side caching genuinely does pin you to one pod.',
  {
    kind: 'misconception_corrected',
    note: 'Confused headless Services with normal ones. Normal Services resolve to a single stable VIP.',
    trigger: kubeProxy.id,
  },
);
mark(dns.id, 'understood', 'didnt_know');

const headless = ask(svc.id, dns.id, 'When would I actually want a headless Service?');

/* -------------------------------------------- relations, including cross-topic */

q.createRelation({
  from_id: needSvc.id,
  to_id: traffic.id,
  kind: 'depends_on',
  note: 'A Service is only useful if its endpoint list is trustworthy, and readiness is what makes it trustworthy.',
});
q.createRelation({
  from_id: kubeProxy.id,
  to_id: slice.id,
  kind: 'depends_on',
  note: 'kube-proxy watches EndpointSlices to know what to write its rules against.',
});
q.createRelation({
  from_id: cpu.id,
  to_id: oom.id,
  kind: 'contradicts',
  note: 'Same shape of question, opposite outcome — compressible versus incompressible resources.',
});
q.createRelation({
  from_id: livenessFails.id,
  to_id: oom.id,
  kind: 'related_to',
  note: 'Both end in a restarting container, for completely different reasons — easy to misdiagnose.',
});
q.createRelation({
  from_id: startup.id,
  to_id: livenessFails.id,
  kind: 'example_of',
  note: 'The failure a startup probe exists to prevent.',
});
q.createRelation({
  from_id: pending.id,
  to_id: requests.id,
  kind: 'depends_on',
  note: 'Cannot reason about a Pending pod without knowing requests are what the scheduler counts.',
});
q.createRelation({ from_id: dns.id, to_id: clusterIp.id, kind: 'depends_on' });

/* -------------------------------------------------------- a little drill history */

q.submitReview({
  question_id: requests.id,
  rating: 'could_explain_deeply',
  recalled: 'Requests schedule, limits constrain at runtime.',
});
q.submitReview({ question_id: affinity.id, rating: 'didnt_know' });

const n = db.prepare(
  `SELECT count(*) AS n FROM question WHERE book_id IN (
     SELECT id FROM book WHERE title IN (?,?,?))`,
).get(...TOPICS) as { n: number };

console.log(
  `seeded ${TOPICS.length} Kubernetes topics, ${n.n} questions\n` +
    `  · 2 misconception trails (running≠ready, DNS≠load balancing)\n` +
    `  · 7 relations, incl. cross-topic Services → health checks\n` +
    `  · 1 parked rabbit hole, ${q.dueQuestions(99).length} questions due for drill`,
);
