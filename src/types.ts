export const STATES = [
  'unexplored',
  'exploring',
  'understood',
  'can_explain',
  'verified',
] as const;
export type State = (typeof STATES)[number];

/** Ordinal position of each state, used by the drill floor/ceiling rules (D4). */
export const STATE_RANK: Record<State, number> = {
  unexplored: 0,
  exploring: 1,
  understood: 2,
  can_explain: 3,
  verified: 4,
};

export const RELATION_KINDS = [
  'related_to',
  'depends_on',
  'contradicts',
  'example_of',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const REVISION_KINDS = [
  'initial',
  'refinement',
  'misconception_corrected',
  'merged_from_child',
  'post_drill',
] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const RATINGS = [
  'didnt_know',
  'partially_knew',
  'knew_it',
  'could_explain_deeply',
] as const;
export type Rating = (typeof RATINGS)[number];

export const SOURCE_KINDS = [
  'book',
  'article',
  'paper',
  'video',
  'lecture',
  'website',
  'experiment',
  'conversation',
  'personal_observation',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface User {
  id: string;
  google_sub: string | null;
  email: string;
  name: string | null;
  avatar_url: string | null;
  /** The subdomain their published books live on. Null until they claim one. */
  handle: string | null;
  bio: string | null;
  is_admin: boolean;
  can_publish: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface Book {
  id: string;
  user_id: string;
  title: string;
  intent: string | null;
  /** The shelf this book sits on, if any (SCHEMA.md D15). Null means unsorted. */
  library_id: string | null;
  slug: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** A named shelf a user can group their Books onto (SCHEMA.md D15). */
export interface Library {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Question {
  id: string;
  book_id: string;
  parent_id: string | null;
  title: string;
  understanding: string | null;
  state: State;
  position: number;
  parked_at: string | null;
  park_reason: string | null;
  next_review_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Revision {
  id: string;
  question_id: string;
  understanding_before: string | null;
  understanding_after: string | null;
  kind: RevisionKind;
  note: string | null;
  triggered_by_question_id: string | null;
  created_at: string;
}

export interface Review {
  id: string;
  question_id: string;
  rating: Rating;
  recalled: string | null;
  state_before: State;
  state_after: State;
  reviewed_at: string;
}

/**
 * D4: a drill rating sets a floor or a ceiling on understanding, and schedules the
 * next drill. Deliberately crude fixed intervals — no ease factor, no card queue.
 * Never promotes to `verified`; that needs a source reconciliation (D3).
 */
export const DRILL_RULES: Record<
  Rating,
  { direction: 'ceiling' | 'floor'; bound: State; days: number }
> = {
  didnt_know: { direction: 'ceiling', bound: 'exploring', days: 1 },
  partially_knew: { direction: 'ceiling', bound: 'understood', days: 3 },
  knew_it: { direction: 'floor', bound: 'understood', days: 7 },
  could_explain_deeply: { direction: 'floor', bound: 'can_explain', days: 21 },
};

export function applyRating(current: State, rating: Rating): State {
  const rule = DRILL_RULES[rating];
  const cur = STATE_RANK[current];
  const bound = STATE_RANK[rule.bound];
  if (rule.direction === 'ceiling') return cur > bound ? rule.bound : current;
  return cur < bound ? rule.bound : current;
}

export function nextReviewAt(rating: Rating, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + DRILL_RULES[rating].days);
  return d.toISOString();
}
