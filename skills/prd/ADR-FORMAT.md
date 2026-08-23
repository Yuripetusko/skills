# ADR Format (fallback)

Prefer the dedicated **adr-skill** if it's installed. This file is the minimal fallback so the PRD
skill never has a dead cross-reference — when an ADR is needed, write it like this.

An ADR records **that** an architectural decision was made and **why**. It can be a single paragraph.

## Where

`docs/adrs/YYYY-MM-DD-short-slug.md` (in a monorepo, `packages/<pkg>/docs/adrs/`). Reuse the repo's
existing ADR directory if it has one.

## Minimal template

```md
# {Short title of the decision}

{1–3 sentences: the context, what was decided, and why.}
```

That's a complete ADR. Add optional sections only when they earn their place:

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by <link>`) — for decisions that get revisited.
- **Consequences** — non-obvious downstream effects.
- **Alternatives** — rejected options worth remembering, so nobody re-proposes them in six months.

## When to write one

All three must hold: **hard to reverse**, **surprising without context**, and **the result of a real
trade-off**. If a decision is easy to reverse, not surprising, or had no real alternative — skip it.

An ADR is **not** a PRD: keep implementation plans, affected-file lists, and verification checklists
in the PRD, not the ADR.
