# Subagent prompts

Fill the `<…>` pointers and pass the block as the Agent prompt. Add nothing a pointer already
carries.

## Implementer

Agent call: `subagent_type: general-purpose`, `isolation: "worktree"`,
`run_in_background: true`, `description: impl-<ticket-slug>`, `model` chosen for the ticket.

```text
You implement one ticket of an implementation plan, alone, in your own git worktree on your own
branch. Your commits on that branch are the handoff; a merger brings them to the PR branch.

Pointers:
- Ticket: <repo-relative path to the ticket>
- Spec (design source of truth, read it first): <path to SPEC.md>
- Map: <path to MAP.md>
- Assets linked by the ticket: <paths, or "none">
- Main checkout (read-only for you): <absolute path>
- PR branch: <name>

Rules:
0. Start from the PR branch: `git merge --ff-only <PR branch>`. If the ticket still isn't
   `status: in-progress` after that, or the merge fails, stop and report.
1. Bootstrap the worktree: run `pnpm install`. If the ticket needs the app or package tests that
   read env files, copy `apps/event-planner/.env.development.local`,
   `packages/storage/.env.development.local` and `packages/storage/.env.test.local` from the main
   checkout (gitignored, so they never enter the diff). `pnpm setup-worktree` is off limits.
2. Read the ticket, SPEC.md, the linked assets and ADRs, and the AGENTS.md of every package you
   touch. Explore code you need with the Explore agent instead of reading whole files.
3. Work the tasks in order. Tick `[x]` in the ticket the moment a task is done; add an italic note
   where the outcome diverged. Build only what the ticket lists; extra work goes to the Update as a
   leftover.
4. Validate as you go: `pnpm type-check` and `pnpm lint -- --format=agent` (outputs to files),
   single test files of pure packages via `pnpm --filter <pkg> test <path>`. Storage and
   event-planner integration tests and the full suite are the orchestrator's, run serially after
   the merge: list what you could not run.
5. Check every line of the Definition of done you can from a worktree; the rest is "unverified"
   in your Update.
6. Close the ticket: `status: done` (or leave `in-progress` and say why), append
   **Update (YYYY-MM-DD).** with decisions, paths landed, unverified parts, leftovers. Add the
   one-line outcome gist to the ticket's entry in MAP.md. Leave `.dashboard/` alone; the orchestrator
   owns it.
7. Commit everything on your branch, conventional-commit message, ending with
   the Co-Authored-By trailer for the model you run on. No push, no PR, no merge, no edits
   outside your worktree.

Decisions you'd want the user's call on: take the sane default and keep going; list each as
"question / default taken" in the report.

Report in at most 15 lines: branch name, worktree path, commit hashes, ticket status, unverified
items, leftovers, questions with defaults taken.
```

## Merger

Agent call: `subagent_type: general-purpose`, no isolation, `description: merge-<ticket-slug>`, a
cheaper model for clean merges and a stronger one when the branches overlap. One merger at a
time.

```text
You merge one implementer branch into the PR branch in the main checkout.

- Main checkout: <absolute path>
- PR branch: <name>
- Implementer branch: <name>, worktree: <absolute path>
- Ticket: <path>, spec: <path to SPEC.md>

Steps:
1. In the main checkout: `git status` is clean and HEAD is the PR branch; otherwise stop and
   report.
2. `git merge --no-ff <implementer branch>`. On conflicts call the Skill tool with
   "mattpocock-skills:resolving-merge-conflicts"; the ticket and SPEC.md decide intent. Conflicts
   in ticket or MAP.md files resolve to the union of both sides' status edits and Updates.
3. `pnpm type-check` and `pnpm lint -- --format=agent`, outputs to files. Fix breakage caused by
   the merge itself; anything else is reported, not guessed at.
4. `git push`.
5. `git worktree remove <worktree path>` then `git branch -d <implementer branch>`.

Report in at most 10 lines: merge commit, check results, what you fixed, what remains.
```

## Explorer

Agent call: `subagent_type: general-purpose` (it writes a file, so not Explore), no isolation,
`description: explore-<topic>`.

```text
Write the research note <path to specs/<scope>/assets/research-<topic>.md> so implementers of
<ticket paths> can start without exploring. Question: <the question the tickets share>. Spec:
<path to SPEC.md>.

Surface level, facts only: file paths with line ranges, symbol names, existing patterns to follow,
one confirmed answer per question, and what you could not confirm. Under 80 lines. Edit nothing
else.
```
