---
name: annotate-pr-changes
description: >-
  Post short inline review comments ("🤖 Agent: **Change annotation for the reviewer**") on the
  few non-obvious parts of a pull request - complex logic, changes that drastically alter existing
  behavior, unobvious fixes or approaches - so a human reviewer gets the "why" without reading the
  spec, ticket or agent session behind it. Use it right after opening a pull request (after
  `gh pr create`), and whenever asked to annotate, explain, or add reviewer context to a PR that is
  already open, including one written by another agent, session or teammate. It explains changes;
  it is not a code review. Skips merged, closed and human-approved PRs. Optional argument: the PR
  as `3204`, `#3204` or its GitHub URL; without one, the current branch's PR. Add --dry-run to
  draft the annotations without posting.
argument-hint: '[3204 | #3204 | PR URL] [--dry-run]'
---

# Annotate PR changes

The goal: wherever a reviewer without the spec, ticket or agent session would stop and ask "why is
this here?", the answer is already pinned to that line. Nowhere else. Every annotation costs the
reviewer a read, so an annotation on something obvious makes the review slower, not faster. The
default for any hunk is no annotation, and zero annotations is a valid result.

**If you wrote the code and just opened the PR** (the usual case right after `gh pr create`), you
already know why each change is there. Skip the research: no subagent A, no spec, plan, ticket or
Linear search, no session or memory lookups (sections 2A and 4). Run section 1, then subagent B
on the map - it catches what you've forgotten and what already carries a comment - and choose and
write from your own context. Research only a hunk you genuinely can't explain anymore. Most of
this skill's length is for annotating someone else's PR.

## 1. Resolve the PR, its diff, and what's already explained

- The PR argument may be `3204`, `#3204` or a GitHub PR URL. Strip a leading `#`; for a URL, take
  the number after `/pull/` (a URL for another repo: pass `--repo <owner>/<repo>` to every `gh`
  call and the validator). No argument: `gh pr view --json number` for the current branch. Below,
  `<n>` is the bare number.
- No PR yet: you are in the opening flow. Push, open the PR per the repo's PR conventions, then
  continue here. Annotations anchor to the PR's diff, so they cannot exist before it.
- **Check the state before anything else.** A merged, closed, or human-approved PR has no review
  left to speed up, so annotations would help no one: tell the user and stop, without reading the
  diff or spawning subagents. If the user named a reviewer, point to the open PR they probably
  meant (`gh pr list --search "review-requested:<login>"`).

  ```bash
  gh pr view <n> --json state,url --jq .state   # stop unless OPEN
  # only for an OPEN PR:
  gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews \
    --jq '.[] | select(.state == "APPROVED" and .user.type != "Bot") | .user.login'
  ```

  Any login printed is a human approval: stop. Approvals from bots (`user.type == "Bot"`, such as
  the repo's `approve-simple-prs[bot]`) don't count, since no human has read the change. The PR's
  `reviewDecision: APPROVED` can come from a bot alone, so don't stop on it.
- Load the open PR: `gh pr view <n> --json
  number,url,title,body,reviewDecision,reviewRequests,baseRefName,headRefName,headRefOid,author,files,commits`.
- The diff under review is `gh pr diff <n>`: exactly what GitHub shows, against the PR's own base
  (stacked PRs included), with merges from main left out. Take line numbers from it, never from
  the local working tree.
  - If you wrote the code: check `git rev-parse HEAD` equals `headRefOid`. Unpushed commits shift
    every line number; push first.
  - If you did not: don't check out the branch. The main checkout is shared with other agents and
    may hold their uncommitted work. Read head-side files with `git show <headRefOid>:<path>`
    (after `git fetch origin <headRefName>` if the commit is missing locally).
  - `gh pr diff` refuses very large PRs. Then save
    `git diff $(git merge-base origin/<baseRefName> <headRefOid>) <headRefOid>` to a file and pass
    it to the scripts with `--diff-file`.

**Code reviewed in another PR.** Merge commits in `commits` whose headline names a branch other
than the base (`Merge pull request #3162 from ...`, `Merge remote-tracking branch
'origin/feat/...'`) bring in code from another PR. Find that PR (`gh pr list --state all --head
<branch>`); if it was reviewed or merged on its own, its code has been reviewed there and gets no
annotations here. Pass it to the map below with `--reviewed-in`.

**Map the diff.** Nobody reads the full diff, not you and not the subagents. Split it once:

```bash
mktemp -d   # prints <dir>; shell variables don't survive between commands, so reuse the path
node .agents/skills/annotate-pr-changes/scripts/split-pr-diff.mjs <n> <dir> [--reviewed-in <other-pr>]...
```

It saves the diff and one diff file per changed file, and prints one line per file: number,
`+added/-deleted`, status, path, new-side hunk ranges, and notes (`generated`, `from #<other>:
x/y added lines`). That table is the only part of the diff you read yourself. An empty table:
stop and say so.

**What's already explained.** Before spawning anything, list the existing review comments and
review bodies:

```bash
gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments \
  --jq '.[] | {path, line, original_line, outdated: (.line == null), user: .user.login, body: .body[0:120]}'
gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews \
  --jq '.[] | select(.body != "") | {user: .user.login, state, body: .body[0:200]}'
```

A spot counts as covered when any agent note sits on it (any `🤖 Agent:` comment, not only this
skill's prefix) or a human has already asked about it (that thread is theirs). Outdated threads
show `line: null`; place them by `original_line`. If the existing notes already cover the PR,
you may be done here: report that and stop.

## 2. Gather context and triage the diff in parallel subagents

Whoever wrote the code decides what you need:

- **You wrote it in this session:** B only, as described at the top. Your context replaces A.
- **Someone else wrote it** (another session, a teammate, or you in an earlier session): run A and
  the B subagents together, in one message.

**Slice the map for B.** Drop rows marked `generated`, rows whose added lines mostly come
`from #<other>` (reviewed there), and spec or docs rows (A reads those). Group the rest by package
or app into slices of up to ~800 changed lines; a small PR is a single slice. One B per slice.

**Match the model to the work.** A `general-purpose` subagent inherits the session's effort level,
often high, which makes plain lookups slow. Use this skill's agent types instead:

| Work | `subagent_type` |
| --- | --- |
| A, the section 4 lookups, and B on a slice of config, dependency bumps, renames, tests or wiring | `annotate-pr-fast` (Opus 5, low effort) |
| B on a slice of ordinary application code | `annotate-pr-standard` (Opus 5, medium effort) |
| B on a slice with intricate logic (concurrency, permissions and RLS, data migrations, scoring or other algorithms, retries and error paths), or checking a claim that spans several files | `annotate-pr-deep` (latest Opus, high effort) |

When a slice sits between two tiers, take the lower one; a B that can't settle a hunk says so, and
you re-run just that slice one tier up. Choosing and writing the annotations stays with you. If
these agent types aren't available, use `general-purpose`.

All are read-only: no edits, no posting, no messages to other sessions, no skills. Give each the
PR number, `headRefOid`, the covered spots in its files, and its part of the map with the
per-file diff paths, never the diff text. A gets the whole table but no diffs. If you can't spawn
subagents, do their work inline in the same order, slice by slice.

### Subagent A: spec, ticket and plan

Find the documents and decisions behind the change, matching on the map's paths rather than
reading diffs (open a per-file diff only to check a specific claim). Record the sources that
turned up nothing as well:

1. **The PR itself.** Body, conversation (`gh pr view <n> --comments`), commit messages. Commit
   messages are cheap and often hold the reason for a fix.
2. **Spec, ticket or plan.** Strongest signal: spec or ticket files changed in the PR itself (a
   ticket flipped to `done`). Otherwise search, matching on branch-name words, ticket ids and the
   files and identifiers the diff touches:
   - `specs/<scope>/` - `SPEC.md`, `MAP.md`, `tickets/*.md` - at the repo root and under
     `packages/*/` and `apps/*/`
   - legacy `plans/<name>/` - `plan.md`, `prds/*.md` - same three places
   - ADRs: `apps/event-planner/docs/adrs/`, `packages/payment/docs/adrs/`
3. **Linear.** Every Linear issue linked or mentioned anywhere: an EF-id in the branch name
   (`fix/ef-1660-...`), `resolves EF-1660` or a `linear.app` link in the body, commit messages,
   PR comments, or the spec and ticket files found above. When the Linear MCP is available, read
   each with `get_issue`, plus `list_comments` when the issue body is thin. Without it, keep the
   ids and links for the report.

Return: each source found, with a link the reviewer can open (GitHub blob URL at `headRefOid` for
repo files, Linear URL for issues), and the decisions it holds that explain the change: behavior
changes and their reasons, root causes of fixes, alternatives that were rejected, constraints.
Short quotes, not dumps. Also flag any place where the PR description contradicts the diff.

### Subagent B: diff triage

Read only the per-file diffs of your slice (`<dir>/files/<#>.diff`). When a hunk needs its
surroundings, read that part of the file with `git show <headRefOid>:<path>`. Return only the
hunks a reviewer without context would likely stop at:

- complex logic whose reason the code doesn't show
- behavior that changes for existing callers, users or data: a removed guard, a changed default,
  different ordering, a backfill or data migration, a changed permission gate or RLS policy,
  different error handling
- a fix whose root cause the change doesn't make visible
- an approach that looks wrong or roundabout at first sight: a workaround, deliberate
  duplication, not using the obvious helper, a disabled lint rule, a retry or sleep
- a deletion of something that looks needed

Skip outright: covered spots and code from another PR (both from section 1); renames, moves,
formatting, import shuffles; generated files (drizzle `meta/` snapshots, lockfiles, test
snapshots, generated types); straightforward additions that follow an existing pattern; tests,
unless a test pins down a surprising behavior.

For each candidate: `path`, the line range (new-file lines, `RIGHT`; old-file lines on `LEFT`
only for a spot that is purely deleted), one sentence on what changed in behavior, the question a
reviewer would ask, and whether a code comment in or right next to the hunk, or the PR
description, already answers it.

## 3. Choose

Keep a candidate only when all three hold:

- **A reviewer would likely ask why**, or would take it for a bug.
- **Nothing already answers it**: no code comment at the spot, no clear paragraph in the PR
  description, no existing note or thread from section 1. When something answers it only in part,
  annotate just the missing part, if that part alone would still stop a reviewer. A PR description
  that contradicts the diff answers nothing: the contradiction is itself worth an annotation on
  the diff line that does what the description says it doesn't.
- **You have a source.** A claim about intent (why the author chose this) needs a document,
  ticket, decision or person behind it. A claim about behavior or impact (what the change does,
  what else it reaches, its real limits) can rest on code you verified; cite it as `path:line`.
  Never present an inferred intent as fact: a confident wrong explanation is worse than none.

Annotations explain the change: what it was before, why it moved, which decision drove it. A
reason that stays true after merge (why the code is the way it is) belongs in a code comment
instead. If you are the author, add that comment and push rather than annotating; if you are not,
annotate and mention in the report that a code comment would serve better.

Most PRs need between zero and four annotations. Past about six you are narrating the diff; keep
the ones a reviewer is most likely to stop at.

## 4. Fill the gaps: authoring session and memory

Only for kept candidates that the spec, ticket, plan and Linear left unexplained, and only when
you didn't write the code. Ask subagent A (`SendMessage`, so it keeps its context) or a fresh
`annotate-pr-fast` subagent to look for the reason of exactly those `path:line` spots:

- **The authoring session.** PR bodies usually carry a `Session:` line or a `## Sessions`
  section, with a bare UUID, a `local_...` id, a `claude://...` link, or just a title.
  - Bare UUID (Claude Code CLI session): the transcript is `~/.claude/projects/*/<uuid>.jsonl`.
    Grep it for the files and identifiers in question rather than reading it whole.
  - `local_...` id (desktop session): `mcp__ccd_session_mgmt__get_session`, then `list_events`.
  - Title only, or nothing: `mcp__ccd_session_mgmt__search_session_transcripts` with the branch
    name, PR number or EF-id (`include_archived: true`).
  - A teammate's session lives on their machine. Not finding it is normal; move on.
- **Project memory.** The `MEMORY.md` index in the project's auto-memory directory
  (`~/.claude/projects/<project-slug>/memory/`), for entries that name this feature or PR.

If the authoring session is live (it shows up in `ListAgents`) and idle, you may ask it yourself
with `SendMessage`: one message, each question as `path:line` plus what you need to know. Ask for
the reason only, never ask it to post, edit or run anything. Then end your turn saying you're
waiting; the reply arrives as a new message and you continue at section 5. If it's busy, holds
messages for approval, or you were told not to message other sessions, don't ask. Don't send
follow-ups asking whether it saw the message.

Whatever is still unexplained after this goes into the report as an open question, not into an
annotation.

## 5. Write

Each comment body is the prefix line, a newline, then 1-3 sentences:

```
🤖 Agent: **Change annotation for the reviewer**
<why this change is needed>
```

- Lead with the reason. The diff already shows what changed; don't describe it again.
- For a behavior change, say before -> after and who or what it affects.
- For a fix, give the root cause in one sentence.
- Link the source when it lets the reviewer check the claim: a spec section or ticket (GitHub
  blob URL at `headRefOid`), an ADR, a Linear issue. For a decision from a session transcript,
  state the decision itself.
- Plain words, no hedging, no jargon.

Restates the code (don't): "Ordering now filters the event requirements by those shown in the
table before sorting." Explains it (do): "Before, the sort used every event requirement, so a
company could rank first on a requirement the table hides. Only the shown ones count now
([SPEC: Ordering](https://github.com/...))."

Anchor each comment on the line that raises the question - usually the first changed line of the
hunk. A multi-line range (`start_line` to `line`) helps only when the reason covers the whole
block.

## 6. Post

**Zero annotations:** no payload and no validator run; go straight to the report.

**Build the payload** as `<dir>/payload.json` (the map's directory) with the Write tool. One
review carries all comments, so the reviewer gets a single notification:

```json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "comments": [
    {
      "path": "packages/storage/src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "🤖 Agent: **Change annotation for the reviewer**\nBefore, ..."
    },
    {
      "path": "apps/event-planner/lib/example.ts",
      "start_line": 10,
      "start_side": "RIGHT",
      "line": 18,
      "side": "RIGHT",
      "body": "🤖 Agent: **Change annotation for the reviewer**\n..."
    }
  ]
}
```

- `event: "COMMENT"` is required. Without it the review is created as pending, visible only to
  the account that made it.
- No review `body`: the review carries only the line annotations, with no general comment, summary
  or reading order. GitHub normally accepts a `COMMENT` review without a body when it has inline
  comments. If posting fails with a 422 that asks for a body, add exactly
  `"body": "🤖 Agent: Change annotations for the reviewer on the lines below."`, re-run the
  validator with `--allow-body`, and post again. Nothing more goes in that line.
- The `\n` inside a JSON string is a real newline once parsed, which is what you want. Don't build
  bodies with `gh api -f body='...\n...'`: that posts a literal backslash-n.

**Validate** - every time, because one anchor outside the diff makes GitHub reject the whole
review with a 422:

```bash
node .agents/skills/annotate-pr-changes/scripts/validate-review-anchors.mjs <n> <dir>/payload.json \
  --diff-file <dir>/pr.diff
```

It checks that `commit_id` is the PR head, that every anchor sits inside a diff hunk on its side,
and that every body starts with the prefix line; it then prints a preview with the line each
comment lands on. `--diff-file` reuses the diff saved by the map; check first that the PR head
hasn't moved since (`headRefOid`), or drop the flag to fetch it fresh. Fix and re-run until it
prints `VALID`.

**Dry run** (`--dry-run`, or the user asked to see the annotations first): stop here and show
the preview plus the payload path.

**Post:**

```bash
gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews --input <dir>/payload.json --jq .html_url
```

If an earlier annotation of yours no longer matches the code under it, tell the user; don't edit
it silently.

## 7. Report

Tell the user, briefly. The report is as minimal as the annotations: this skill is not a code
review, so don't list bugs, policy questions, deprecations or risks you noticed along the way. A
finding that would change the review gets one line at most.

- the review URL (or, on a dry run, the preview) with the number of annotations
- what was skipped as already covered: existing notes and threads, code reviewed in another PR
- open questions: candidates you couldn't explain, as `path:line` plus the question. These are
  worth a code comment or a PR description note from the author.
- spots where a code comment would serve better than an annotation, and any place the PR
  description or a commit message contradicts the diff, one line each
- which context sources were found, and which weren't, in one or two lines
