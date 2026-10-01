---
name: orchestrate-implementation-team
description: >-
  Implement a whole implementation plan (specs/<scope>/) on one draft PR by orchestrating
  implementer subagents in worktrees over the ticket frontier, merging their branches as they land,
  then code-reviewing the PR branch and sweeping the plan's statuses.
disable-model-invocation: true
argument-hint: '<specs/<scope> | path to SPEC.md or MAP.md | scope name>'
---

# Orchestrate implementation team

You have been given an implementation plan: `specs/<scope>/` holding `SPEC.md`, `tickets/`,
`MAP.md` and `frontier.sh`. The goal is one PR that implements the whole plan on a single branch.

The tickets are not a list of steps. They are a **task graph** with `blockedBy` edges, so there is
always a **frontier** of tickets ready to be taken; `./frontier.sh` next to MAP.md prints it.

You are the orchestrator. Once you hold the gist and the state of the plan, delegate: subagents
implement, merge and explore, while you read reports, keep the frontier moving, and change the PR
branch only through a merger. Communication with subagents is sparse and goes through **context
pointers**: SPEC.md, a ticket path, MAP.md, an asset, a commit. Restate nothing a pointer already
carries. Implementers run in the background for maximum concurrency.

You also own the plan's **dashboard** (`specs/<scope>/.dashboard/`): the user's window into the
run while you keep going. The to-implementation-plan skill's `assets/dashboard.js` feeds it; from
the repo root run
`node .agents/skills/to-implementation-plan/assets/dashboard.js --scope <plan folder>`, written
`<dashboard>` below. Only you write it; implementers' ticket edits live in their worktrees until
merged. Run `<dashboard>` after every claim, report and merge, and record each
subagent's state with `<dashboard> agent <ticket> <state>`.

**Choose models per subagent.** Nothing here fixes a model. Pick per task: the strongest available
for tickets with real design judgment or tricky merges, a cheaper one for mechanical tickets,
exploration and clean merges. Say which you chose in the ledger note.

**Don't stop for decisions.** When you need the user's call and a sane default exists, run
`<dashboard> ask "<question>" --default "<what you'll do>" --ticket <id>` and carry on with
the default. Stop only for what has no safe default (destructive, irreversible, or outside the
spec). When the user answers, `<dashboard> answer <id> "<answer>"` and correct course.

## Locate the plan

The argument is a folder, a path to SPEC.md or MAP.md, or a scope name. For a scope name, look
for `specs/<name>/` at the repo root and under `packages/*/` and `apps/*/`. A legacy
`plans/<name>/` is not an implementation plan until `/to-implementation-plan` has migrated it.
Validate, and stop with a pointer to `/to-implementation-plan` when anything is missing:

- `SPEC.md` exists.
- `tickets/` holds at least one `*-ticket.md` with a yaml `status`.
- `MAP.md` and an executable `frontier.sh` sit next to it.

## Ground rules for this repo

- The main checkout is shared with the user and other agents. Start only from a clean
  `git status`; dirty files you did not create belong to someone else, so stop and ask.
- Storage and event-planner integration tests use Neon branches keyed by developer and git
  branch. One test invocation at a time across every checkout: implementers run lint, type-check
  and unit tests of pure packages only; you run integration and full suites serially, after
  merges.
- Tickets that add a database migration run alone (migration ordinals collide across worktrees):
  merged before the next one starts.
- One merger at a time; mergers work in the main checkout on the PR branch.
- At most three implementers in flight unless the user raises the cap; each worktree costs a full
  `pnpm install`.
- Stop only processes you started. Never kill dev servers by pattern.
- A fresh worktree has no `node_modules` and no `.env.*.local` files. `pnpm setup-worktree` needs
  1Password and is not for subagents; the implementer prompt tells them what to copy instead.

## Steps

1. **Read the plan.** SPEC.md, MAP.md, `./frontier.sh`. Zoom into ticket bodies only to judge
   overlap and migrations; implementers read their own ticket. A ticket already `in-progress`
   with no live subagent is a crashed session: read its Update, then re-dispatch it.

2. **Dashboard.** `<dashboard>`. If `.dashboard/index.html` is missing
   or still the fallback page (it says "Fallback dashboard" in a comment), dispatch
   `dashboard-builder` in the background with the scope path and say this plan runs a subagent
   team. Give the user the dashboard right away as a markdown link to the repo-relative path
   `<dashboard> path` prints, outside backticks so the Claude app can open it. The
   dashboard's agent ledger is your ledger: the note carries branch and worktree path.

3. **Branch and draft PR.** On the default branch, create `feat/<scope>` (`fix/` or `chore/`
   when the spec says so); on any other branch, use it as the PR branch unless the user objects.
   Commit `specs/<scope>/` if it is not committed yet (mergers stop on a dirty checkout), push, and open a draft PR with
   `gh pr create --draft`. Conventional-commit title, body that links `specs/<scope>/SPEC.md` and
   `MAP.md` by path, no test plan, ending with
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

   **Explore (optional).** When several tickets need the same exploration (a subsystem's shape, a
   vendor API), dispatch one exploration subagent (prompt in `references/subagent-prompts.md`)
   that writes `specs/<scope>/assets/research-<topic>.md`. Commit it to the PR branch before
   dispatching, so every worktree inherits it.

4. **Dispatch the frontier.** For each frontier ticket that can run independently:
   - Overlap check: two frontier tickets whose tasks name the same files run one after the other.
     A migration ticket runs alone.
   - Claim it: set `status: in-progress` in the ticket and commit on the PR branch. The worktree
     inherits the claim and `frontier.sh` stops listing it.
   - Launch an implementer: `subagent_type: general-purpose`,
     `isolation: "worktree"`, `run_in_background: true`, a model chosen for the ticket, described
     as `impl-<ticket-slug>`, prompt from `references/subagent-prompts.md`. Then
     `<dashboard> agent <ticket> dispatched --note "<model>, <branch>"`.

5. **Merge as they land.** When an implementer reports, launch a merger (no
   isolation, prompt from `references/subagent-prompts.md`). It merges the implementer branch into
   the PR branch, resolves conflicts, runs type-check and lint, pushes, and removes the worktree
   and branch. Track it on the dashboard: `agent <ticket> reported`, `merging`, `merged`. Questions
   the implementer reports (with the default it took) go to `<dashboard> ask`. An implementer
   that reports failure or leftovers: `agent <ticket> failed` and, when it blocks progress,
   `stuck "<what>"`; read its Update in the ticket, then re-dispatch with a sharper pointer, split
   the ticket, or move the leftover to a sibling ticket. Never open a PR from a worktree.

6. **Advance the frontier.** After every merge, re-run `./frontier.sh`. New tickets: back to
   step 4. Keep the frontier saturated within the cap.

7. **Verify serially.** Frontier empty and everything merged: run the full test suite once on the
   PR branch, output to a file, exit code echoed (`pnpm test > <scratchpad>/test.log 2>&1;
echo $?`). Failures go to an implementer as a ticket-shaped prompt (worktree, then merger).

8. **Code review.** Call the Skill tool with "code-review" against the PR branch. Every finding
   is fixed through an implementer (worktree, then merger); then type-check and lint again.

9. **Sweep the plan.** Every ticket `done` with its Definition of done met, tasks ticked and a
   final **Update**; every MAP.md entry carries its outcome gist; `Next up:` is cleared or points
   at a leftover sibling. Commit and push.

10. **Clean up.** `git worktree list` shows no worktree of this run; `git worktree prune`; every
    merged implementer branch deleted.

11. **Announce.** Report the PR URL, tickets landed, leftovers moved and where, what the review
    changed, and every dashboard question still open with the default you took. Then ask the user whether to mark the PR ready (`gh pr ready`) or leave it a
    draft for their manual review. The PR stays a draft until they answer.
