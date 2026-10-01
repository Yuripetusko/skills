---
name: to-adr
description: Create and maintain Architecture Decision Records (ADRs) for agentic coding workflows. Use to propose, write, update, accept/reject, deprecate, or supersede an ADR; bootstrap an adr folder and index; or consult existing ADRs before changing architecture. ADRs are lean — a title plus a few sentences — and can be written ad-hoc mid-planning without a grilling session.
---

# To ADR

An ADR records **that** an architectural decision was made and **why**. It can be a single
paragraph. The value is capturing the decision and its rationale so a future reader (human or agent)
doesn't re-litigate it — not in filling out sections.

Write them **ad-hoc, in the middle of planning or coding, without asking permission or running an
interview.** Draft it, surface it, move on. Don't gate the work behind a questionnaire or a review
checklist.

## When to write one

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth
   did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and one was picked for
   specific reasons.

If any of the three is missing, skip it: note the reasoning in a code comment and continue. If all
three hold, just write it — no multi-phase workflow, no intent summary to confirm.

**What qualifies:** architectural shape (monorepo; event-sourced write model); integration patterns
between contexts (domain events vs synchronous HTTP); technology choices that carry lock-in
(database, message bus, auth provider — not every library); boundary/scope decisions ("the Customer
context owns customer data; others reference it by ID"); deliberate deviations from the obvious path
("manual SQL instead of an ORM because X"); constraints not visible in the code (compliance, a
partner SLA); and rejected alternatives whose rejection is non-obvious (so nobody re-proposes
GraphQL in six months).

**Don't** write one for routine choices within an established pattern, bug fixes, style preferences
covered by linters, or decisions already captured in an existing ADR (update that one instead).

## What an ADR is not

Not a PRD or an implementation plan: no affected-file lists, task breakdowns, or verification
checkboxes — those belong in the PRD/plan the ADR feeds. The ADR records _what was decided and why_
and links out to the PRD for _how to build it_.

## How to write one

1. **Directory.** Reuse the repo's existing ADR dir if there is one. Otherwise create one lazily —
   `docs/adrs/` is a good default; `docs/decisions/` (MADR), `adr/`, `docs/adr/`,
   `contributing/decisions/`, and `decisions/` are common variants. **In a monorepo, prefer a dir
   per package/domain** (e.g. `packages/<pkg>/docs/adrs/`) so decisions live next to the code they
   govern. Details + variants: `references/adr-conventions.md`.
2. **Filename.** Date-prefixed: `YYYY-MM-DD-short-slug.md` (e.g. `2026-06-03-choose-database.md`). If
   the repo already uses slug-only or numbered files, match that.
3. **Content.** A title and 1–3 sentences is a valid ADR. Add optional sections only when they earn
   their place: `Status` (frontmatter), `Context`, `Decision`, `Consequences`, `Alternatives`.
   Templates live in `assets/templates/` (`adr-simple.md`; `adr-madr.md` for options-heavy
   decisions — see `references/template-variants.md`).
4. **Generate it.** Preferred: `node scripts/new-adr.js --title "Choose database" --status proposed`
   (run from this skill's directory; auto-detects the dir + filename strategy, defaults to a date
   prefix). If you can't run scripts, copy a template and fill it in.

## Status lifecycle

Track status in YAML front matter: `proposed → accepted` (or `rejected`); later `deprecated` (no
longer applies — note the replacement path) or `superseded by <link>` (replaced by a newer ADR — link
both ways). Status is what keeps an ADR set honest as decisions age.

Use `scripts/set-adr-status.js` for in-place status changes. Prefer appending dated notes over
rewriting history; if a decision is replaced, write a new ADR and supersede the old one.

## Consulting ADRs before changing architecture

Before working on architecture-touching code (auth, data layer, API design, infra), or when a human
says "check the ADRs":

1. Find the ADR dir (the variants above; also look for a `README.md` / `index.md`).
2. Scan titles + statuses; read the relevant `accepted` ones.
3. Respect them: don't contradict an accepted ADR without writing a new one that supersedes it. If
   the code already contradicts an accepted ADR, flag it.

### Code ↔ ADR linking

When code implements a non-obvious ADR decision, drop a one-line reference at the entry point so the
reasoning stays discoverable:

```ts
// ADR: docs/adrs/2026-06-03-use-sqlite-for-tests.md
```

One comment at the entry point, not on every line.

## Bootstrap a repo with no ADRs

```bash
node scripts/bootstrap-adr.js                  # create the dir, an index, and a first "Adopt ADRs" record
node scripts/bootstrap-adr.js --dir docs/decisions   # override the dir
```

## Resources

- `scripts/new-adr.js` — create an ADR from a template (auto-detects dir + naming; `--template madr`, `--status`, `--update-index`, `--json`).
- `scripts/set-adr-status.js` — update an ADR's status in place (`--json` for machine output).
- `scripts/bootstrap-adr.js` — create the dir, index, and an initial "Adopt ADRs" record.
- `references/adr-conventions.md` — directory variants, date-prefix filenames, status values, monorepo categories.
- `references/template-variants.md` — when to use the simple vs MADR template.
- `references/examples.md` — filled-out short and long ADR examples.
- `assets/templates/` — `adr-simple.md`, `adr-madr.md`, and `adr-readme.md` (index scaffold).
