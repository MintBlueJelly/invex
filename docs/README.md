# InvEx documentation

Start at the [project README](../README.md) if you want to build and run it. Everything else lives
here.

| Document | Read it if you want |
| --- | --- |
| [about.md](./about.md) | To understand what InvEx is and why it works the way it does — no code, no commands |
| [api.md](./api.md) | To integrate with it: every endpoint, the canonical invoice schema, and the behavioural sharp edges |
| [deployment.md](./deployment.md) | To run it: the services it needs, how they relate, what holds state, what breaks |
| [glossary.md](./glossary.md) | To decode a term — the domain, pipeline, AI and testing vocabulary, plus words that mean something specific here |
| [review.md](./review.md) | The narrative code review: what is wrong, why it matters, and what follows from it |
| [known-bugs.md](./known-bugs.md) | The machine-checked defect registry — every row pinned by a test |
| [briefing.md](./briefing.md) | The original design brief and the reasoning behind it |

**`review.md` and `known-bugs.md` share the `INVEX-nnn` id namespace.** `review.md` is the prose
argument — it groups findings into themes and explains the consequences. `known-bugs.md` is the
registry: one row per defect, each pinned by at least one test, with the correspondence enforced by
`packages/server/test/unit/knownBugs.registry.test.ts`. Look a defect up by id in `known-bugs.md`;
read `review.md` to find out why anyone should care.
