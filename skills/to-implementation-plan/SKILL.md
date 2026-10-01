---
name: to-implementation-plan
description: >-
  Turn a spec (SPEC.md) or the current conversation into an implementation plan in Operator's
  house style: specs/<scope>/ holding SPEC.md, session-sized tickets with yaml status and
  blockedBy edges, MAP.md, frontier.sh and assets/. Planning only; implementation runs in a fresh
  session via /implement-next-ticket or /orchestrate-implementation-team.
disable-model-invocation: true
argument-hint: '[specs/<scope> | path to SPEC.md, plan.md or intent.md | free-text intent]'
---

# To implementation plan

An **implementation plan** is the folder `specs/<scope>/`, written so a fresh session (or a
subagent that never saw this conversation) can implement from it:

- `SPEC.md`: the design source of truth. Goal, why, locked decisions, design, pivots.
- `tickets/<name>-ticket.md`: one session-sized deliverable each, wired with `blockedBy` edges.
- `MAP.md`: the index of tickets and the `Next up:` cursor. `frontier.sh` beside it prints the
  takeable tickets.
- `assets/`: context too long for SPEC.md (research notes, captured payloads, rejected designs),
  linked from SPEC.md or a ticket.
- `spikes/`: exploratory write-ups.

Layout, naming, yaml status, the map and the scaffolding scripts:
`references/ticket-conventions.md`.

## Planning only

The session ends when the implementation plan is complete: SPEC.md, tickets, MAP.md and
frontier.sh in place, statuses set, the second pass (below) done. Implementation belongs to a fresh
session. When the user asks to implement here, say that this skill stops at the plan and point them
to a new session with `/implement-next-ticket` (one ticket per session) or
`/orchestrate-implementation-team` (the whole plan, with subagents).

## Scope name

`<scope>` is a short, descriptive kebab-case name that summarizes the main intent of the
implementation plan (`outlook-first-quoted-level`, `deposit-reachability`). Derive it from the
intent unless the user provides one; a branch name or issue id is not a scope name. `<root>` is
the repo root, or the package dir in a monorepo (`packages/<pkg>/specs/<scope>/`).

## The spec gate

Tickets are generated from SPEC.md, never from memory of the conversation alone. Resolve it in
this order:

1. `specs/<scope>/SPEC.md` exists: read it, plus `CONTEXT.md` and the ADRs it links.
2. A legacy `plans/<scope>/plan.md` exists: it is the spec. Move the folder to `specs/<scope>/`
   and rename `plan.md` to `SPEC.md` (the rest of the legacy layout:
   `references/ticket-conventions.md`).
3. The user supplied an `intent.md` or similar notes, or the conversation carries enough context:
   draft SPEC.md from it with `assets/templates/spec-template.md`, then confirm it with the user.
4. Otherwise tell the user that a SPEC.md is required to generate tickets, and call the Skill tool
   with "grilling" to gather what is missing. Write SPEC.md once the frontier of questions is
   empty.

## Light research

When the intent is still vague, or a ticket needs a fact (does this helper exist, which file owns
this flow, what does the vendor endpoint return), dispatch the Explore agent, or a
`general-purpose` subagent on a cheaper model than yours when the question is shallow, to find it. Surface level only: file paths, symbol names,
one confirmed fact per question. The implementing session runs its own research before it starts,
so the plan needs enough to make tickets actionable, not a survey.

## Write for a fresh session

SPEC.md and the tickets are read by someone with none of this conversation. Give them what they
need to act without re-deciding: the whys, the whats, and the pivots (what changed direction and
what it replaced). Record every locked discussion as a one-line decision with its reason. Context
that would make SPEC.md long goes to `assets/<name>.md`, linked from the SPEC or ticket that needs
it, with one line saying when to read it. Enough to act on, not a transcript.

## Amend in place

While planning, a decision that changes rewrites the affected prose, tickets and edges to the
latest truth. No "Amended in the same session" paragraphs, no appended corrections: the reader
gets one current version. Keep history only where the record prevents a repeat (a rejected
alternative someone will re-propose, a costly lesson), one sentence, in place. Git history is the
changelog.

## Ticket anatomy

```markdown
---
status: ready # ready | in-progress | blocked | parked | done
# blockedBy: sibling ticket filenames and/or quoted one-line human prerequisites. Only when blocked/parked
#   - other-feature-ticket.md
#   - "Yuri creates the Stripe test key"
---

# Ticket: <Feature name>

One session-sized deliverable of [<scope>](../SPEC.md). The spec is the design source of truth;
surface gaps there first, don't re-litigate here. Working rules:

- Tick `[x]` the moment a task is done; flip the yaml `status` at the same cadence.
- Don't add scope that isn't listed.
- Move leftovers to a sibling ticket instead of holding this one open.
- Append an **Update (YYYY-MM-DD).** paragraph at the end when you stop working.

## Why this exists

<1–2 paragraphs: the problem, and why the scope is shaped this way.>

## Design notes

<Named sub-decisions and invariants: "do X not Y, and the failure mode if you don't". `###` per
topic. Link an ADR for anything that was a real decision rather than a detail.>

## Tasks

- [ ] <task: name the affected paths, deps to add/remove, patterns to follow/avoid>

## Definition of done

<Checkable verification: commands to run, greps that come back empty, observable behaviour. Not
"it works".>

## Prerequisites

- [ ] <human/manual prerequisite, one sentence each; the gate is `status: blocked` above>

## Out of scope

- <explicitly out, so the implementer doesn't build more than asked>
```

## Per-task status

Task checkboxes carry the live work state; the yaml `status` is the only doc-level status. Nothing
else stores status: no status tables, none in MAP.md. The progress dashboard (below) is a derived,
gitignored view regenerated from the tickets; it never holds status of its own. `parked` means
deliberately deferred: the tasks stay unticked and double as the future spec (strike-through stays
reserved for rejected work); `blockedBy` holds the one-line reason.

## Tasks (the execution body)

- Write the Definition of done first; the tasks must satisfy it.
- Tasks name the affected paths/files, dependencies, and patterns to follow/avoid, concrete enough
  to start without guessing. That detail is what an ADR deliberately omits. Worked example:
  `references/examples.md`.
- Annotate a finished task with an _italic note_ when the outcome diverged from the spec.
- The closing **Update (YYYY-MM-DD).** paragraph is the handoff: key decisions, paths landed,
  what's untested, leftovers moved and where.

## Split into sibling tickets

Slice like tracer bullets: each ticket cuts a narrow but complete path through every layer and is
demoable or verifiable on its own. Vertical, not one layer. Size to one fresh session; past ~15
tasks, split. A ticket that can't start until another lands gets `status: blocked` plus
`blockedBy:` naming the sibling path. Work the frontier: any ticket whose blockers are done.
`./frontier.sh` next to MAP.md lists it (born with MAP.md via `new-ticket.js --update-index`).

Unfinished, blocked, or newly surfaced work never holds a ticket open either: move it to a sibling
(or a follow-ups ticket), mark this one `done` for what it delivered, record the move in the
Update, and tell the author.

## Progress dashboard

Every plan gets a one-page dashboard the user double-clicks to watch planning and implementation:
`specs/<scope>/.dashboard/index.html`, gitignored, refreshing every 10s. It shows ticket and task
progress, what's stuck, questions waiting on the user with the default taken meanwhile, and the
latest deliverables.

- This skill's `assets/dashboard.js` derives everything from the tickets into
  `.dashboard/data.js`. Plans don't carry a copy. From the repo root, run
  `node .agents/skills/to-implementation-plan/assets/dashboard.js --scope specs/<scope>` (below:
  `<dashboard>`; `--scope` is the folder holding MAP.md) after any ticket edit. Its subcommands
  hold what tickets can't: `ask "<q>" --default "<action>"`, `answer <id>`, `stuck "<what>"`,
  `unstuck <id>`, `agent <ticket> <state>`, `log "<text>"`, and `path` prints the page's
  repo-relative path. Header of the script has the usage.
- The page itself is designed once per plan by the `dashboard-builder` agent (installed in
  `~/.claude/agents/`; source in `assets/agents/`). Until it lands, a fallback page is in place.
  Without the agent installed, the fallback stays.
- While planning, open questions still go through grilling and the spec gate, never `ask`: a
  default baked into tickets while the question sits open is how plans go stale. `ask` with a
  default is for the implementing skills.

## Open questions

A ticket has no Open-questions section. If open questions persist, grill the user (Skill tool,
"grilling"); generate the ticket once they're resolved.

## Runtime vs operator

Make explicit who performs each step: the **runtime** (code, automatic) or the **operator** (a
human clicking, confirming, deciding). When a step is manual by design, say so and name the ticket
that automates it.

## Linked ADRs

Real decisions live in ADRs linked from Design notes. Use the `to-adr` skill if installed,
otherwise [ADR-FORMAT.md](./ADR-FORMAT.md). Keep ADR rationale out of the ticket.

## Spikes

A spike (`specs/<scope>/spikes/<name>.md`) reduces uncertainty; its deliverable is a finding, so no
checkboxes or Definition of done. End it with an **Outcome / next step** line. A spike that
greenlights work is promoted to a ticket; a decision it lands becomes an ADR.

## Second pass

When the plan is complete, get an outside read before handing it off. Take the first branch that
applies:

1. `/codex:adversarial-review` is in your skill list: run it with `--wait --scope working-tree`
   and the focus text "review the implementation plan under specs/<scope>/ for missing tickets,
   wrong blockedBy edges, decisions SPEC.md leaves open, and tasks an implementer can't start
   from".
2. The `advisor` tool is available: call it with the same question, pointing at SPEC.md and
   MAP.md.
3. Neither: skip the pass and say so in the handoff.

Fold accepted findings into the plan in place. A question the review reopens goes back through
the spec gate, not into a ticket.

## Process

1. Resolve the scope name and pass the spec gate. Read the design source: SPEC.md, `CONTEXT.md`,
   linked ADRs, existing `assets/`.
2. Open questions left: grill the user; light research for facts. Write or amend SPEC.md in place.
3. Slice the scope into session-sized sibling tickets and wire `blockedBy` edges.
4. Per ticket: Definition of done first, then tasks; explicit Out of scope; link ADRs; long
   context to `assets/`.
5. List prerequisites; set `status: blocked` where they gate coding. Scaffold with
   `scripts/new-ticket.js --update-index` so MAP.md and frontier.sh exist; set the `Next up:`
   cursor.
6. Dashboard: `<dashboard>`, then dispatch `dashboard-builder` in the background
   (`run_in_background: true`) with the scope path. Keep planning; don't wait for it. An existing
   plan with a hand-built page (not the fallback) keeps it.
7. Second pass; fold findings in place. `<dashboard>` again.
8. Stop. The handoff names the scope folder, the first frontier ticket, the two implementation
   skills, and the dashboard as a markdown link to the repo-relative path `<dashboard> path`
   prints, like `[dashboard](specs/<scope>/.dashboard/index.html)`. Keep that link out of
   backticks, because the Claude app opens markdown links, not code spans.

## Resources

- `scripts/new-ticket.js`: scaffold a ticket (`--scope`, `--title`, `--update-index`, `--json`).
- `scripts/bootstrap-spec.js`: scaffold `specs/<scope>/` (`tickets/`, `spikes/`, `assets/`).
- `assets/templates/spec-template.md`: SPEC.md skeleton for drafting from notes or grilling.
- `assets/templates/ticket-template.md`: the ticket skeleton.
- `assets/templates/map-template.md`: MAP.md, born on the first `--update-index`.
- `assets/frontier.sh`: lists takeable tickets; copied next to MAP.md on first `--update-index`.
- `assets/dashboard.js`: the dashboard feed, run from here with `--scope`; never copied.
- `assets/templates/dashboard.html`: fallback dashboard page and the `window.DASH` reference.
- `assets/agents/dashboard-builder.md`: source of the agent; copy to `~/.claude/agents/`.
- `references/ticket-conventions.md`: layout, naming, yaml status, the map, the Next-up cursor,
  the legacy `plans/` layout.
- `references/examples.md`: one worked ticket.
- `ADR-FORMAT.md`: ADR fallback when `to-adr` isn't installed.
