# PRD Conventions (Reference)

## Where files go

A scope (epic / feature / git branch, kebab-case) groups everything under `plans/<scope>/`:

- `plans/<scope>/plan.md` — the design source of truth (the brood-mother plan).
- `plans/<scope>/prds/<name>-prd.md` — one PRD per coherent deliverable / user story.
- `plans/<scope>/spikes/<name>.md` — exploratory write-ups.
- Companion design docs (`CONTEXT.md`, `DATA_MODEL.md`) sit alongside `plan.md`.

ADRs live separately under `docs/adrs/` — they outlive any single plan. In a monorepo, scope both to
the package: `packages/<pkg>/plans/<scope>/` and `packages/<pkg>/docs/adrs/`.

## Naming

- PRDs: kebab-case + the `-prd.md` suffix — e.g. `payment-webhook-ingestion-prd.md`. No ordinal in
  the filename (don't encode order in names — that's what made `phase-1-m2.5-…` painful to insert/reorder).
- A large plan fans out into several PRDs under the same scope dir; flag a new PRD whose name doesn't
  match the pattern of its siblings.
- Milestone headings carry no ordinal either: `## Milestone — <name>`. Reorder by moving the block.

## Status (one tier)

There is **no status table** and no scope-level dashboard. Status lives in exactly one tier, inside
the PRD being worked:

- **Task checkboxes** (`- [ ]` / `- [x]`) — the live work state.
- **Milestone heading** — append ` ✅` when its Definition of done is met; that's the only
  milestone-level status. In-progress = some tasks ticked, no ` ✅` yet.

Flip these inline as you work — same cadence — and append an `**Update (YYYY-MM-DD).**` log at the end
of a milestone. There is deliberately **no status script and no `Blocked` status**: blocked work moves
into a new milestone (so the current one can close) rather than flagging one that never does. A
dropped task is `~~struck through~~`, never deleted.

## Index (optional, multi-PRD only)

There is no required index. When a plan fans into several PRDs and you want a map, a **status-free**
`README.md` (a pointer to `plan.md` + a plain link list of PRDs) is worth keeping — generated on
demand by `new-prd.js --update-index`. It must not mirror per-milestone status (that duplication is
exactly what this convention removes). Ordering, when it matters, lives in `plan.md`.

Optionally, the scope's home (top of `plan.md`, or the README if one exists — one place, never both)
can carry a one-line **`Next up:`** cursor: a best-effort forward pointer to the next PRD to work on.
It's the only ordering bit that isn't derivable (for "last worked," use `git log` or the newest
`**Update (…)**`). Treat it as a hint — verify the target PRD isn't already done before trusting it.
