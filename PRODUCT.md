# Pinball Learn — Product Specification

## Product

**Pinball Learn** is a domain-agnostic learning platform built around **questions, exploration, and evolving understanding**.

> Learn by following your questions.

It is not a note-taking app, course platform, or flashcard system.

The platform helps users move from:

**Curiosity → Questions → Exploration → Understanding → Explanation → Retention**

It should work for any subject: science, mathematics, history, technology, languages, philosophy, music, economics, or anything else someone wants to understand.

---

## Core Philosophy

Traditional learning tools organize **information**.

Pinball Learn organizes **the process of understanding**.

The fundamental learning loop is:

```text
I want to understand something
        ↓
Ask a question
        ↓
Form a current understanding
        ↓
Discover a gap
        ↓
Ask a subquestion
        ↓
Explore
        ↓
Correct misconceptions
        ↓
Return to the original question
        ↓
Improve the mental model
        ↓
Explain it from memory
```

The system should preserve this journey rather than only storing the final polished answer.

---

## Learning Exploration

The primary container is an **Exploration**.

An Exploration represents something the learner wants to understand.

```text
Exploration:
Understand how evolution works

Goal:
Build enough understanding to explain
evolution and the evidence behind it.
```

Users should not need to organize knowledge into folders or predefined topics before learning.

Structure should **emerge from exploration**.

---

## Questions

The **Question** is the primary learning object.

```text
Why does evolution happen?
│
├── What is natural selection?
│   ├── What creates genetic variation?
│   └── Why do traits become more common?
│
├── How do new species emerge?
│   └── What is reproductive isolation?
│
└── How do we know evolution happened?
    ├── Fossil evidence
    ├── Genetics
    └── Observed evolution
```

A question can contain:

* Current understanding
* Subquestions
* Related questions
* Sources/evidence
* Understanding state
* Revision history
* Review history

Creating a subquestion must be extremely low-friction.

---

## Recursive Exploration

Learning should feel like navigating a chain of curiosity.

When a question creates another question:

```text
Parent Question
      ↓
Subquestion
      ↓
Deeper Question
      ↓
Discovery
```

the learner should always be able to understand:

* Where they started
* Why they asked the current question
* What remains unanswered
* How the discovery affects the parent question

After resolving a subquestion, encourage returning to the parent and revising its answer.

---

## Learning Intent

Exploration can easily become an infinite rabbit hole.

Every Exploration therefore has a **Learning Intent**.

Example:

```text
Goal:
Understand enough economics to explain
why central banks raise interest rates
during inflation.
```

Questions can then be evaluated relative to that intent.

```text
Interest Rates
│
├── How do rates affect borrowing?       ← relevant
├── How does demand affect inflation?    ← relevant
├── How do bond markets work?            ← useful
└── History of central banking           ← possible rabbit hole
```

Do not prevent rabbit holes.

Help users recognize them and optionally **park them for later**.

Curiosity should be preserved without allowing it to destroy the original learning objective.

---

## Current Understanding

Answers represent the learner's **current mental model**, not an authoritative encyclopedia entry.

Example:

```text
Question:
Why do cells need mitochondria?

Current understanding:
Mitochondria convert energy stored in nutrients
into ATP that cells can use.
```

The system should encourage users to explain concepts in their own words.

---

## Learning Trail

Never treat previous misunderstandings as useless data.

Preserve how understanding changed.

```text
Question
   ↓
Initial assumption
   ↓
New question
   ↓
Investigation
   ↓
Misconception discovered
   ↓
Mental model updated
```

Example:

```text
Why do heavier objects not fall faster?

Initial:
Heavier objects should experience more gravity,
so they should fall faster.

↓ explored

Discovered:
They experience more gravitational force,
but also have proportionally greater inertia.

↓ revised

Current understanding:
Ignoring air resistance, gravitational acceleration
is independent of the object's mass.
```

The transition from **wrong → understood** is part of the learning artifact.

---

## Understanding States

Questions should have lightweight learning states.

```text
Unexplored
Exploring
Understood
Can Explain
Verified
```

### Can Explain

The learner can explain the concept from memory without referring to their notes.

This distinction is important:

> Recognizing an explanation is not the same as being able to produce one.

---

## Drill Mode

Pinball should periodically challenge the learner with previously explored questions.

```text
Explain:

Why does raising interest rates
usually reduce inflation?

[ Start Answering ]
```

The original answer remains hidden.

After answering, the learner compares their explanation with their previous understanding.

Self-rating:

```text
Didn't Know
Partially Knew
Knew It
Could Explain Deeply
```

Review results determine what should be revisited.

This is **active recall**, not a traditional flashcard system.

---

## Knowledge Graph

Questions should not be restricted to a tree.

A discovery in one Exploration may connect to another.

```text
Natural Selection
      │
      ├── Genetics
      │
      └── Probability
```

Support relationships such as:

```text
PARENT_OF
RELATED_TO
DEPENDS_ON
CONTRADICTS
EXAMPLE_OF
```

The graph should emerge naturally from learning.

Do not require users to manually maintain a complicated knowledge graph.

---

## Knowledge Map

Provide a visual representation of the learner's understanding.

The map should help reveal:

* What has been explored
* What remains unanswered
* How concepts connect
* Knowledge dependencies
* Deep rabbit holes
* Weak understanding
* Previously parked questions

The map exists to support learning, not to become a graph-management tool.

---

## Sources & Evidence

Questions may reference learning material:

```text
Book
Article
Paper
Video
Lecture
Website
Experiment
Conversation
Personal observation
```

Sources support the learner's reasoning but should not replace their own explanation.

The system should distinguish:

```text
Source says X

vs.

I understand X because...
```

---

## Minimal Data Model

Start simple.

```text
Exploration
Question
QuestionRelation
Revision
Source
Review
```

Conceptually:

```text
Exploration
│
├── Learning Intent
│
└── Questions
      │
      ├── Current Understanding
      ├── Relations
      ├── Sources
      ├── Revisions
      └── Reviews
```

Use a relational database initially.

Do not introduce graph databases unless real usage demonstrates the need.

---

## Primary Views

### Exploration

The main learning workspace.

Show:

* Learning intent
* Current question
* Current understanding
* Parent question
* Subquestions
* Related questions
* Sources
* Understanding state

Navigation between parent and child questions must feel instantaneous.

### Knowledge Map

Visualize how understanding has developed.

### Drill

Test whether understanding can be reproduced from memory.

### Learning Trail

Show how the learner's mental model changed over time.

---

## Product Principles

1. **Questions over notes.**
2. **Understanding over information collection.**
3. **Curiosity drives navigation.**
4. **Learning structure should emerge naturally.**
5. **Do not require organization before understanding.**
6. **Preserve misconceptions and reasoning history.**
7. **Make subquestions frictionless.**
8. **Always preserve the path back to the original question.**
9. **Distinguish recognition from explanation.**
10. **Help control rabbit holes without suppressing curiosity.**
11. **Optimize for depth, not quantity of notes.**
12. **Remain domain-agnostic.**

---

## Domain Independence

Never design features around a specific subject.

The same system must work naturally for:

```text
Why does Kubernetes need readiness probes?

Why does raising interest rates reduce inflation?

Why did the Roman Republic collapse?

Why does integration calculate area?

Why do dominant chords create tension?

Why do cells need mitochondria?

Why does this Japanese sentence use は instead of が?
```

Domain-specific behavior should be optional and layered on top of the core learning model.

---

## AI Philosophy

AI may eventually assist with:

* Suggesting useful subquestions
* Identifying missing assumptions
* Challenging explanations
* Detecting possible misconceptions
* Generating drills
* Comparing explanations
* Identifying connections
* Estimating whether a branch is becoming a rabbit hole

AI should **support thinking, not replace it**.

Avoid turning the experience into:

```text
Ask AI → receive answer → save answer
```

Prefer:

```text
Learner thinks
      ↓
AI challenges
      ↓
Learner investigates
      ↓
Learner revises understanding
```

The learner should remain responsible for constructing their mental model.

---

## V1 Scope

Build only what is required to validate the core loop:

```text
Create Exploration
      ↓
Define learning intent
      ↓
Ask question
      ↓
Write current understanding
      ↓
Create subquestions
      ↓
Explore recursively
      ↓
Return to parent
      ↓
Revise understanding
      ↓
Mark understanding
      ↓
Review later
```

Prioritize:

* Exploration creation
* Question creation
* Recursive question navigation
* Current understanding
* Parent/child relationships
* Basic related-question links
* Understanding states
* Revision history
* Parked questions
* Simple drill mode

---

## Not V1

Do not prioritize:

* Courses
* Certificates
* Social feeds
* Collaboration
* Gamification
* Public publishing
* Complex AI tutors
* Full LMS functionality
* Traditional flashcard systems
* Complex graph infrastructure
* Extensive customization

Do not let secondary features obscure the core learning loop.

---

## UX North Star

A learner should be able to begin with:

```text
"I want to understand inflation."
```

and naturally develop:

```text
Understand Inflation
│
├── What actually causes inflation?
│   ├── What is demand-pull inflation?
│   ├── What is cost-push inflation?
│   └── What role does money supply play?
│
├── How is inflation measured?
│   ├── What is CPI?
│   └── Why can CPI feel different from my experience?
│
└── How do governments respond?
    └── Why do central banks raise interest rates?
```

without having to decide folders, tags, taxonomy, or curriculum beforehand.

The product succeeds when the learner can look back and see not just **what they learned**, but:

> **how their questions turned into understanding.**

---

## Identity

**Product:** Pinball Learn
**Domain:** `learn.pinball.sh`

The Pinball metaphor represents the learning process:

**One question leads to another, ideas collide, connections emerge, and understanding develops through exploration.**
