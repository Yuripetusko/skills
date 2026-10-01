---
name: implement-next-ticket
description: >-
  Implement exactly one ticket of an implementation plan (specs/<scope>/) in the current checkout:
  take it from the frontier or the Next up cursor, claim it, work its tasks, verify its Definition
  of done, close it and hand off. One ticket per session.
disable-model-invocation: true
argument-hint: '[specs/<scope> | path to a ticket, SPEC.md or MAP.md | scope name]'
---

# Implement next ticket

One ticket, this session, in this checkout. No worktree, no branch switching, no merging: you work
where the user works, and the user commits unless they ask you to.

## Locate the plan

The argument is a ticket path, a folder, a path to SPEC.md or MAP.md, or a scope name. For a
scope name, look for `specs/<name>/` at the repo root and under `packages/*/` and `apps/*/`. A
legacy `plans/<name>/` is not an implementation plan until `/to-implementation-plan` has migrated
it. Stop with a pointer to `/to-implementation-plan` when `SPEC.md`, `tickets/`, `MAP.md` or
`frontier.sh` is missing.

## Steps

1. **Load the map.** Read MAP.md (the plan at low resolution) and SPEC.md. Run `./frontier.sh`.

2. **Choose the ticket.** A ticket the user named: use it once its yaml status is `ready`, or
   `blocked` with every listed blocker `done`. Otherwise the `Next up:` cursor when its target is
   on the frontier, else the first frontier ticket. An empty frontier: report what blocks each
   open ticket and stop.

3. **Claim.** Set `status: in-progress` before any work and move `Next up:` to the following
   frontier ticket. From the repo root run
   `node .agents/skills/to-implementation-plan/assets/dashboard.js --scope <plan folder>`
   (written `<dashboard>` below) and give the user the dashboard as a markdown link to the
   repo-relative path `<dashboard> path` prints, outside backticks so the Claude app can open it.
   No to-implementation-plan skill installed: skip the dashboard. No `.dashboard/index.html`
   (fresh clone; the folder is gitignored): copy that skill's `assets/templates/dashboard.html`
   there.

4. **Read for the ticket.** The ticket body, the assets and ADRs it links, and the AGENTS.md of
   every package it names. Code you need to see: dispatch Explore or a `general-purpose` subagent
   on whatever model fits the question, and read its findings. The implementation stays with you.

5. **Work the tasks.** In order. Tick `[x]` the moment a task is done, then `<dashboard>`;
   add an italic note where the outcome diverged. Build only what the ticket lists; new work goes
   to a sibling ticket and the Update. A decision with a sane default:
   `<dashboard> ask "<q>" --default "<action>" --ticket <id>` and carry on with the default.
   Something you can't get past: `<dashboard> stuck "<what>"`.

6. **Validate regularly.** Type-check and lint after each task, single test files as you go, the
   full suite once at the end, all per the repo's validation checklist in CLAUDE.md. One test
   invocation at a time: storage and event-planner integration tests use Neon branches keyed by
   git branch, and a parallel run deletes the other's branches. Verify live with the agent
   browser where the change is observable in the app.

7. **Definition of done.** Check every line. What you cannot verify is named in the Update, not
   claimed.

8. **Review.** Call the Skill tool with "code-review" on the working tree. Fix findings inside
   this ticket's scope; the rest become leftovers.

9. **Close.** `status: done` (or stay `in-progress` and say why), the final
   **Update (YYYY-MM-DD).** with decisions, paths landed, unverified parts and leftovers, the
   one-line outcome gist on the ticket's MAP.md entry, `Next up:` pointing at the next frontier
   ticket. `<dashboard>`.

10. **Hand off.** Report the ticket, paths landed, unverified items, leftovers, the next frontier
    ticket, and every open dashboard question with the default you took.

## One ticket per session

When the user asks to continue with another ticket, remind them that this skill's instructions
are one ticket per session and point to a fresh `/implement-next-ticket` session, or
`/orchestrate-implementation-team` for the remaining frontier. If they reaffirm, that is their
call: say so and take the next frontier ticket from step 2.
