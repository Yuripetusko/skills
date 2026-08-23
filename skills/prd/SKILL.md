---
name: prd
description: >-
  Write a PRD using Operator's house conventions — milestone-based structure (de-numbered
  milestone headings, each with a "Definition of done" acceptance line and a post-milestone
  "Update" log), a "Pre-PRD action items" gate, linked ADRs (via the adr-skill or
  ADR-FORMAT.md), a runtime-vs-operator responsibilities split, and lean PRDs that split into
  siblings before they sprawl. Use when the user wants to create/draft a PRD, spec, or
  implementation plan, or asks to follow "my PRD conventions / format / house style".
---

# Writing a PRD (Operator's house style)

This skill encodes how Operator structures Product Requirement Docs. The reference
corpus is `client-outreach-boilerplate/prds/*.md` (execution-shaped PRDs) and
`foo-monorepo/packages/payment/` (a `plans/<scope>/plan.md` + `docs/adrs/`
decision set). A PRD
here is an **execution plan** — the _design_ lives in a companion `plan.md` / ADRs,
and the PRD references back to it rather than re-litigating decisions.

## Where files go

A single piece of work (an epic / feature scope / branch) keeps its plan, PRDs, and
spikes together under **one scope directory inside `plans/`**, while cross-cutting
material — decision records and external reference docs — lives under `docs/`, so the
top-level stays clean. The scope segment is the feature scope or git branch name
(kebab-case) — e.g. `payment-setup-mvp`, `lead-enrichment`. `<root>` is the repo root,
or the package dir in a monorepo (e.g. `packages/payment`).

- **Plans + companions** — `<root>/plans/<scopeOrBranchName>/`:
  - `plan.md` — the design source of truth (the "brood-mother" master plan; sub-plans
    and PRDs hang off it).
  - Companion design docs alongside it: `CONTEXT.md`, `DATA_MODEL.md`, and any other
    planning / flow / tracking docs (a diligence checklist, a call agenda, …).
  - `prds/<name>-prd.md` — one PRD per coherent deliverable / user story (always the
    `-prd.md` suffix). A large plan fans out into several PRDs here.
  - `spikes/<name>.md` — exploratory spike write-ups.
- **Cross-cutting docs** — `<root>/docs/`:
  - `docs/adrs/NNNN-<slug>.md` — decision records, **outside the plans tree** (ADRs
    outlive any single plan). Zero-padded 4-digit number + kebab-case slug. (Records
    written during a planning grilling may start as lightweight "planning ADRs" and get
    hardened later.)
  - `docs/refs/<context>/…` — reference material cited but not authored: source PDFs,
    vendor API docs, grouped by source context (`docs/refs/airwallex/`,
    `docs/refs/easybill/`, `docs/refs/sample-documents/`).

The PRD links back to its plan + companions (`../plan.md`, `../DATA_MODEL.md`) and to
ADRs / refs (`../../docs/adrs/NNNN-…`, `../../docs/refs/…`); it does not duplicate their
rationale.

## Scaffolding

Deterministic helpers (dependency-free Node; run from this skill's directory):

- `node scripts/new-prd.js --scope <scope> --title "Phase 1 MVP"` — creates
  `plans/<scope>/prds/<slug>-prd.md` from `assets/templates/prd-template.md`. Optionally add
  `--update-index` to list it in a scope `README.md` — a **status-free map**, worth keeping only once a
  plan fans into several PRDs (it creates the README from `assets/templates/prd-readme.md` if absent).
- `node scripts/bootstrap-prd.js --scope <scope>` — scaffolds a new `plans/<scope>/` (`prds/`,
  `spikes/`). It deliberately does **not** create `plan.md` — the plan is a designed artifact,
  authored via your planning / grilling process, not boilerplate — and does **not** create an index:
  there's no status dashboard, status lives inside each PRD (see below).

If you can't run scripts, copy `assets/templates/prd-template.md` and fill it in.

## Anatomy of a PRD

Order matters — this is the canonical top-to-bottom shape:

1. **Title** — `# PRD: <Feature Name>`.
2. **Instructions for the implementer** — the working rules (see boilerplate below).
   Link the design source of truth here ("refer back to
   `plans/<scopeOrBranchName>/<x>.md` — it is the
   source of truth for everything below. This document is the _execution plan_; the
   plan file is the _design_.").
3. **Why this exists** — 1–3 paragraphs on the problem and why scope is shaped this
   way. Be explicit about what's deliberately _minimal_ and why.
4. **Design notes** — the meat for the implementer: named sub-decisions, invariants,
   "do X not Y and here's the failure mode if you don't". Use `### ` subheadings per
   topic. Call out hard invariants explicitly (e.g. a "**Critical**" or in-prose
   "the implementer's invariant: …" line). Link to ADRs for anything that was a real
   decision rather than a detail.
5. **Milestones** — the execution body; de-numbered headings (see below).
6. **Pre-PRD action items** — human gating items that must happen before coding
   (see below). In a multi-PRD plan this often lives in the parent `plan.md`; include
   it in the PRD when the PRD is self-contained.
7. **Open questions** — unresolved items tracked, not yet decided. State the current
   default ("Defaults to X for MVP; revisit if Y").

## Status (one tier, inside the PRD)

There is **no status table and no scope-level dashboard.** Duplicated status across a parent table,
milestone headings, and checkboxes is the thing that makes these docs expensive to edit, so status
lives in exactly one tier — inside the PRD an agent is already working:

- **Task checkboxes** (`- [ ]` / `- [x]`) carry the live work state.
- **The milestone heading** carries the only milestone-level status: append ` ✅` when its Definition
  of done is met. In-progress = some tasks ticked, no ` ✅` yet.

That's it — no `🔄`, no `🅿️`, and deliberately **no `Blocked` status**. Blocked work doesn't sit in a
milestone holding it open; it moves to a new milestone so the current one can close (see the
completion rule below). If you ever want a scope-level overview, the design lives in `plan.md` and the
optional status-free README — neither mirrors per-milestone state.

## Milestones (the execution body)

Each milestone is a self-contained, pausable stopping point — somewhere to review, reflect, or hand
off to a fresh session. It is **not** a separate deliverable (that's the PRD); think of it as a
review/handoff boundary inside one deliverable.

- Heading: `## Milestone — <short title>`. **No ordinal** — identity is the name, not a number, so
  inserting or reordering a milestone is just moving the markdown block; nothing downstream renumbers.
  Append ` ✅` when its Definition of done is met; that marker is the milestone's only status.
- Start with a 1–2 sentence statement of what the milestone delivers and why it's
  sequenced here.
- **Tasks** are GitHub checkboxes: `- [ ]` / `- [x]`. Mark `[x]` the instant a task
  is done — never batch. The checkbox state is how the next session resumes.
- Annotate completed tasks inline with an _italic note_ capturing the real decision
  made: `- [x] Add citty as a dependency. *Promoted to dependencies — needed at
operator runtime, not just dev.*`
- **Strike a task before deleting it — but struck lines aren't forever.** When a task is dropped or
  superseded mid-work (the author changes their mind, or you decide against it for a good reason),
  `~~strike it through~~` with a one-line reason so the in-flight trail survives the session. Once the
  milestone has **closed (`✅`) and the outcome is recorded elsewhere** (the Update, shipped code, an ADR,
  or `git log`), a struck or obsolete task line may be **deleted** — keep it only if it's load-bearing (a
  rejected alternative someone may re-propose). See "Periodic consolidation" below. Don't delete a
  still-open or actively-worked task.
- **Everything that is NOT a task line is replaceable — rewrite, don't append** (2026-06-11; task lines,
  their inline italic notes, and Update paragraphs are append-only _while the milestone is active_ — but
  once it closes, "Periodic consolidation" below lets even those be pruned).
  When a plan pivots, REWRITE the affected prose (intro, Scope, Design notes, open questions) to
  state the latest decision plainly, and delete the superseded text — no "⚠️ re-decided", no
  revision-log blocks, no supersession banners stacking at the top or bottom. Keep history only
  where it is load-bearing (a rejected alternative someone will re-propose, a costly lesson);
  one sentence, in place. Layered revision archaeology is what makes PRDs unreadable and
  uneditable for agents — the git history is the changelog, the PRD is the current truth.
- End every milestone with a **Definition of done** line — this is the acceptance
  criteria. It must be objectively checkable ("Running `pnpm bootstrap backup --yes`
  produces a full-tree tarball in the operator's Drive folder; the recipe skill
  triggered by 'back up my memories' completes without the operator seeing any shell
  calls"). Meet it before checking off the milestone heading.
- **Put the implementation detail in the tasks.** A milestone's tasks should name the **affected
  paths/files**, the **dependencies** to add/remove, and the **patterns to follow/avoid** (plus
  migration steps when replacing something) — concrete enough that an agent starts without guessing.
  This is the detail an ADR deliberately omits; it belongs here. See `references/examples.md`.
- **Write the Definition of done as verification.** Checkable criteria — commands to run, greps that
  should come back empty, observable behaviour — not "it works".
- After a milestone is worked, append an **Update (YYYY-MM-DD).** paragraph: a dense
  prose log of key decisions, file paths landed, gotchas, what's left / not yet
  tested, and any tasks carried to a new milestone (with why). This is the handoff to the next
  agent/session — append fresh ones during active work (`**Update (2026-05-20, follow-up).**`). Once the
  milestone has closed and shipped, a cleanup pass may **consolidate its stacked Updates into one short
  history note** (see "Periodic consolidation"), so they don't accrue forever. Write absolute dates, never
  "yesterday".

### Keep milestones closeable

In practice a milestone is rarely 100% finishable in one pass: some tasks need follow-up work or the
author's input, or new issues / unplanned-but-in-scope tasks surface mid-work. Don't let those hold
the milestone open. Instead:

1. Tick `✅` for what the milestone _did_ deliver.
2. Move the leftovers — carry-over, can't-finish-yet, blocked-on-the-author, and newly-surfaced
   in-scope work — into a **new milestone** (or an existing "follow-ups" milestone that collects
   ad-hoc findings). Relocate them under that heading; the audit trail is the Update paragraph, so
   don't leave struck duplicates behind (strikethrough is for tasks you're _dropping_, not deferring).
3. Record the move + reasons in the closing milestone's **Update**, and **tell the author** about the
   new milestone and anything that needs their input.

This is why there's no `Blocked` status — blocked work becomes its own visible milestone rather than a
flag on a milestone that can never close.

### Periodic consolidation — the append-only zones aren't append-forever

The append-only zones — struck task lines, inline italic notes, Update paragraphs, preserved historical
milestone bodies — exist to keep the in-flight audit trail intact across sessions, so **never prune a
milestone you're actively working.** But they are append-only _during active work_, not forever: left
ungoverned they turn a long-lived PRD into an ever-growing transcript — the very thing that makes it
unreadable and uneditable for the next agent.

So once a milestone is **closed (`✅`) and its outcome is durably recorded elsewhere** — shipped code, an
ADR, a companion doc (`DATA_MODEL`/`CONTEXT`), a later milestone, or `git log` — whether you're closing it
out or on a later cleanup pass, you may:

- **Consolidate its stacked Update paragraphs** into a single short history note (what shipped · the
  load-bearing gotcha · the migration id), and
- **Delete struck or obsolete task lines** whose resolution is captured elsewhere.

Apply the same "keep only what's load-bearing" test the prose rule already uses: a rejected alternative
someone will re-propose, a costly lesson, a migration/gotcha future work needs — keep those (one sentence,
in place); let the rest go. The git history is the changelog; the PRD is the current truth. Aim for
"current truth + a thin history note," not "current truth + a full transcript."

Working rules to paste into "Instructions for the implementer":

```markdown
- **Pause after each milestone.** When a milestone's tasks are all checked off, stop.
  The author may want to clear/switch sessions to keep the context window fresh.
- **Mark each task with `[x]` as soon as it's completed.** Don't batch. The checkbox
  state is how the next session knows where to resume.
- **Flip the milestone marker.** Append ` ✅` to the heading once its Definition of done is met —
  same cadence as ticking tasks. It's the milestone's only status; there is no status table.
- **Keep milestones closeable.** Don't let unfinished, blocked, or newly-surfaced work hold a
  milestone open. Tick `✅` for what's done and move the leftovers into a new milestone (or a
  follow-ups milestone); record the move in the Update and tell the author.
- **Strike a task before deleting it; struck lines aren't forever.** Drop or supersede a task mid-work by
  `~~striking it through~~` with a one-line reason (keeps the in-flight trail). Once the milestone has
  closed and its outcome is recorded elsewhere (Update, code, ADR, `git log`), struck/obsolete lines may be
  deleted — keep only the load-bearing ones; don't delete a still-open task.
- **Prose is replaceable — rewrite, don't append.** Task lines, inline notes, and Update paragraphs are
  append-only _while the milestone is active_; everything else, rewrite to the latest truth and delete what
  it replaces (no revision banners or supersession layers). Once a milestone closes, a cleanup pass may
  consolidate its stacked Updates into one short history note and prune resolved struck tasks.
- **Don't add scope that isn't listed.** If you find something missing or wrong,
  surface it before doing the work — it belongs in the plan/Design notes first, then
  back here as a new task.
- **Keep the PRD lean.** If it grows past ~30 total tasks, stop and ask the author whether to split
  it into sibling PRDs before continuing.
- **Test what you build.** Each milestone has a "Definition of done" line — meet it
  before checking off the milestone heading.
- **Leave a short update.** At the end of a completed milestone, write an Update
  paragraph summarizing key decisions, commands, or findings for the next agent.
- **Repoint the "Next up" cursor.** If the scope keeps one (in `plan.md` or the README), update it to
  the next PRD when you finish — best-effort, and verify a cursor's target isn't already done before
  trusting it.
```

## Pre-PRD action items

A checklist of human/manual prerequisites that must be cleared **before** generating
PRDs and writing code — external config, credential issuance, stakeholder
confirmations. Owner in the heading.

```markdown
## Pre-PRD action items (for Operator)

These must be done before we generate PRDs and start coding Phase 1:

- [ ] **Enable + subscribe to the Airwallex inbound-transfer webhook.** Capture the
      webhook URL, the events subscribed, and the signing secret.
- [ ] Add `AIRWALLEX_WEBHOOK_SECRET` to `packages/payment/src/env.ts` once issued.
- [ ] Confirm with Wolf the canonical disclaimer wording. Tracked in
      [diligence F3](./diligence-checklist.md#f3-...).
```

Each item is a checkbox with a **bolded action** and the concrete artifact to
capture. Link to the tracking doc (diligence checklist, ADR) where one exists.

## Runtime vs operator responsibilities split

Always make explicit _who or what performs each step_: the **runtime** (the running
code/system/script — automatic, deterministic) versus the **operator** (a human
doing a manual action — auth click-through, a confirm prompt, a decision gate). The
PRD should never leave this ambiguous. Patterns from the corpus:

- In user stories, write each actor's line as its own numbered item: "As the
  **system** — when a SEPA transfer lands, the handler verifies the HMAC, matches the
  payment request, marks it paid…" vs "As an **event manager**, I select goals and
  click 'Create payment request'."
- State the boundary as an invariant in Design notes when it constrains the design:
  e.g. "No decision logic in the MCP — the script handles everything" or "don't
  design any step that requires Claude's direct Read/Write to touch a path outside
  the project folder."
- For each milestone task, the inline note or DoD should make clear whether a step is
  automated or a documented manual pause ("Halts the run when triggered; operator
  clicks through and re-invokes").
- When a step is operator-manual _by design_ (e.g. supplier transfer done by hand in
  Phase 2a, automated via API in Phase 2b), say so and note the future automation
  phase.

When the split is load-bearing, a small two-column table ("Step | Runtime | Operator")
in Design notes earns its place. Don't force it where the prose already makes the
actor obvious.

## Linked ADRs

Real decisions live in ADRs, _linked_ from the PRD — the PRD references the decision; the ADR carries
the reasoning. Don't inline ADR rationale in the PRD, and don't hand-write the ADR format here:
**use the `adr-skill` if it's installed; otherwise follow [ADR-FORMAT.md](./ADR-FORMAT.md)** (the
minimal fallback, so this cross-reference is never dead). Cross-link both ways — the plan's hard
constraints cite the ADR that locked each one; the PRD's Design notes link the ADR for anything that
was a genuine choice.

## Keeping PRDs lean (the load-bearing rule)

Because there's no index ordering things, the discipline that keeps a multi-PRD plan editable is that
**each PRD stays lean** — a lean PRD can be edited, re-sliced, or have a milestone inserted surgically,
no matter how many milestones (stopping points) it has. Treat this as an active responsibility while
working a PRD, not a one-time authoring check:

- **Hard nudge at ~30 tasks.** Count the checkbox tasks (DoD lines included). At ≥30, stop and ask the
  author whether to split into sibling PRDs before continuing. Milestone count is irrelevant — total
  tasks is the trigger.
- **Watch for the three drift patterns** and surface them early (don't silently absorb the work):
  - _PRD too thin_ — a whole concern was missed (e.g. the local-dev flow). → add a milestone, or a
    lean sibling PRD.
  - _Need more before moving on_ — e.g. "we should add unit tests before the next milestone." → insert
    a milestone.
  - _Too big for one PR_ — a milestone turned out larger than scoped (e.g. webhooks). → re-slice the
    milestones / split the PRD.
- **Routing new work:** if it needs _investigating_ first → **spike → PRD** (below). If it's already
  clear to _build_ → just insert a milestone or a lean sibling PRD. Both are cheap now that nothing
  carries an ordinal.

## The "Next up" cursor (optional)

A multi-PRD epic worked over days/weeks benefits from a single forward pointer so a returning author
or a cold agent knows where to resume. Keep it to **one best-effort line, in one home** — the top of
`plan.md`, or the scope `README.md` if one exists (never both):

```markdown
**Next up:** [Deposit projection](prds/deposit-projection-prd.md) — _best-effort hint; verify state before starting._
```

It's the only ordering artifact that isn't derivable — a forward pointer can't be inferred from
history (for "last worked," read `git log` over `prds/` or the newest `**Update (…)**`). Treat it as a
hint, not truth: before acting on it, check the pointed-to PRD's checkboxes / `✅`; if it's already
done, advance the cursor or ask. Update it when you start/finish a PRD or when the author asks. Skip it
entirely for a small or single-PRD scope — the author's manual handoff already covers that.

## Spikes → PRDs

A spike (`plans/<scope>/spikes/<name>.md`) is an exploratory write-up that reduces uncertainty — its
deliverable is a _finding_, not shipped code, so it has no checkboxes/DoD ceremony. End every spike
with a short **Outcome / next step** line: the finding, whether it greenlights work, and where that
work goes ("do now as its own PRD" / "fold into milestone X" / "parked — revisit if Y"). A spike that
greenlights work is promoted into a `prds/<slug>-prd.md`; the spike stays as the investigation record.
Spikes often also conclude in a decision — capture that as an ADR (see Linked ADRs) and link it.

## Referencing a PRD from code

When code implements PRD work that isn't self-evident, reference the PRD by **path**, the way the
adr-skill references ADRs — never by ordinal:

```ts
// PRD: plans/payment-setup-mvp/prds/airwallex-webhook-ingestion-prd.md
```

`// As per M2` is meaningless to a future agent or dev; a path is greppable and survives any reorder.

## Process

1. Read the design source first — `plan.md`, `CONTEXT.md`, `DATA_MODEL.md`, existing
   `adrs/`. The PRD restates _what to build and in what order_, not _why_ (that's the
   plan/ADRs). If the design doc doesn't exist yet, say so — a PRD without a design
   source is a smell; offer to draft the plan first or capture decisions as ADRs.
2. Confirm scope: which deliverable/user story this PRD covers, and what's explicitly
   out of scope (PRDs carry an explicit "Out of scope" list per phase/milestone).
3. Draft the PRD in the canonical order above. Slice milestones as **vertical,
   pausable, independently-testable** units — each shippable and checkable on its own.
4. For every milestone, write the Definition of done _first_ (it's the acceptance
   criteria the tasks must satisfy), then the task checkboxes.
5. Surface unresolved decisions as ADRs (link them) or as "Open questions" with a
   stated default — never bury a real decision inside a task.
6. List Pre-PRD action items for anything human/manual that blocks coding.
7. Check the size: if the draft already carries ~30+ tasks, split it into sibling PRDs now rather than
   shipping one PRD that's painful to edit later.

## Quick checklist before declaring a PRD done

- [ ] `# PRD: <name>` title + "Instructions for the implementer" (working rules + link to the design source) directly under it.
- [ ] De-numbered milestones, each with checkbox tasks and a **Definition of done** line.
- [ ] Under ~30 total tasks — otherwise split into sibling PRDs.
- [ ] Runtime vs operator responsibility is explicit for every actor-bearing step.
- [ ] Every real decision is an ADR (linked) or an Open question with a default — not a buried task.
- [ ] Pre-PRD action items listed with owner + artifacts to capture.
- [ ] Explicit "Out of scope" so the implementer doesn't gold-plate.

## Resources

- `scripts/new-prd.js` — scaffold a PRD into `plans/<scope>/prds/<slug>-prd.md` (`--scope`, `--title`, `--update-index`, `--json`).
- `scripts/bootstrap-prd.js` — scaffold a new `plans/<scope>/` (`prds/`, `spikes/`); does not create `plan.md` or an index.
- `assets/templates/prd-template.md` — the canonical PRD skeleton (rendered by `new-prd.js`).
- `assets/templates/prd-readme.md` — the optional status-free scope index (rendered by `new-prd.js --update-index`).
- `references/prd-conventions.md` — file locations, `-prd.md` naming, the one-tier status model.
- `references/examples.md` — a worked milestone (tasks + verifiable Definition of done).
- `ADR-FORMAT.md` — minimal ADR fallback when the `adr-skill` isn't installed.
