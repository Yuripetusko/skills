# PRD: {{TITLE}}

<!-- Part of the {{SCOPE}} scope — see ../plan.md (plans/{{SCOPE}}/plan.md) -->

## Instructions for the implementer

Refer back to [`../plan.md`](../plan.md) — the source of truth for the design, with `CONTEXT.md`,
`DATA_MODEL.md`, and the ADRs alongside it. **This document is the _execution plan_; the plan is the
_design_.** Don't re-litigate decisions here — surface anything wrong or missing into the plan first,
then back here as a task.

- **Pause after each milestone.** When its tasks are all checked off, stop.
- **Mark each task `[x]` as soon as it's done** — don't batch; the checkbox state is the resume point.
- **Flip the milestone marker.** Append ` ✅` to the heading when its Definition of done is met — it's
  the milestone's only status (there is no status table).
- **Keep milestones closeable.** Don't let unfinished, blocked, or newly-surfaced work hold a milestone
  open: tick `✅` for what's done, move the leftovers into a new (or follow-ups) milestone, note it in
  the Update, and tell the author.
- **Never delete a task — strike it.** Drop/supersede a task by `~~striking it through~~` with a reason;
  only remove on the author's request.
- **Prose is replaceable — rewrite, don't append.** Only task lines (and Update paragraphs) are
  append-only. When a decision changes, rewrite the affected prose to the latest truth and delete
  what it replaces; no revision banners or supersession layers.
- **Don't add scope that isn't listed.** Surface gaps into the plan / Design notes first.
- **Keep the PRD lean.** Past ~30 total tasks, stop and ask whether to split into sibling PRDs.
- **Test what you build.** Meet the Definition of done before checking off the milestone heading.
- **Leave a short update.** Append an `**Update (YYYY-MM-DD).**` paragraph at the end of a milestone.

## Why this exists

{1–3 paragraphs: the problem, and why scope is shaped this way. Be explicit about what's deliberately
minimal and why.}

## Design notes

{The meat for the implementer: named sub-decisions, invariants, "do X not Y and here's the failure
mode if you don't". Use `###` subheadings per topic. Link an ADR for anything that was a real
decision rather than a detail.}

## Milestone — {short title}

<!-- No ordinal in the heading — identity is the name. Append ` ✅` to the heading when the Definition
     of done is met. Add more `## Milestone — …` sections as needed; reorder by moving blocks. -->

{1–2 sentences: what this milestone delivers and why it's sequenced here.}

- [ ] {task — name the affected paths/files, deps to add/remove, and the pattern to follow/avoid}
- [ ] {task}

<!-- Optional, when it sharpens the work — the implementation detail an agent needs (this is what an
     ADR deliberately omits; it belongs here):
- **Affected paths**: `src/…`, `tests/…`
- **Dependencies**: add `…`, remove `…`
- **Patterns to follow / avoid**: follow `…`; do NOT `…`
- **Migration steps**: {if replacing something, the incremental path}
-->

**Definition of done:** {objectively checkable acceptance — write it as verification you can run, not
"it works". e.g. "`pnpm test` passes; no imports of Y outside Z; the page renders the goals table".}

## Pre-PRD action items (for {Owner})

Human / manual prerequisites to clear before (or alongside) coding — external config, credential
issuance, stakeholder confirmations.

- [ ] **{bolded action}** — {the concrete artifact to capture}. {Link the tracking doc if one exists.}

## Open questions

- **{question}** — _Default: {X} for MVP; revisit if {Y}._

## Out of scope

- {explicitly out, so the implementer doesn't gold-plate}.
