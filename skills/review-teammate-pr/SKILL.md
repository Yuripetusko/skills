---
name: review-teammate-pr
description: >-
  Review someone else's pull request in four parallel layers (code correctness, code quality
  against the repo's AGENTS.md conventions, semantic intent against the ticket or spec, code
  complexity), then post the findings as inline GitHub comments prefixed "🤖 Agent: **Code
  review ...**" plus one summary comment. Use whenever asked to review, check, look over, or leave
  review comments on a teammate's or another author's PR by number or URL ("review #3209", "can
  you do a review of Stefan's PR", "go through this PR and comment"), even when the word "layers"
  never comes up. Not for your own branch or PR: use a self-review skill (full-review,
  annotate-pr-changes) there if the repo has one.
  Optional argument: the PR as `3209`, `#3209` or its GitHub URL; without one, the current
  branch's PR. Add --dry-run to draft the comments without posting.
argument-hint: '[<PR number> | #<PR number> | <PR URL>] [--dry-run] [--repo owner/name]'
---

# Review a teammate's PR

The goal is a few high-conviction comments, each pinned to the line it's about, each with a
concrete fix. One structural problem beats ten nits. Every comment lands in a colleague's inbox
under the user's GitHub account, so a wrong claim costs more than a missed nit: verify before
posting, and when in doubt leave it out.

The main session is the orchestrator. It never reads the full diff. Subagents read code and return
findings with file and line numbers; the main session verifies, triages, and posts. That keeps the
main context small enough to judge the findings well.

`<skill>` below is this skill's directory (the one holding this file).

## Subagent tiers

Match each subagent's model and effort to how much judgement its step needs. A mechanical step
on high effort wastes minutes. A reasoning step on low effort misses the bug or misreads the
business rule, and a false or missed claim is what this review exists to prevent. The tiers are
agent types defined in `<skill>/agents/` and symlinked into `~/.claude/agents/`:

| `subagent_type`      | Model, effort   | Use for                                                                   |
| -------------------- | --------------- | ------------------------------------------------------------------------- |
| `pr-review-fast`     | Opus, low       | context brief; diff map; quality layer when the PR is small (under ~300 reviewable lines) or mostly mechanical (renames, copy, config, wiring) |
| `pr-review-standard` | Opus, medium    | diff map on large PRs (over ~1,500 reviewable lines); quality layer otherwise |
| `pr-review-deep`     | Opus, high      | correctness, intent and complexity layers; the verifier in step 4         |

Small or mechanical PRs mostly need rule-matching: "does this name follow the documented
convention" doesn't need deep reasoning. Correctness, intent and complexity always do: they trace
behavior, weigh business rules, and judge what a later reader can infer. If the agent types are
missing, use `general-purpose`. Pass `model: "sonnet"` for the fast tier, and leave the model
unset (the session's model) for the others.

## 1. Set up

- **Arguments**, all optional: the PR as `123`, `#123` or a GitHub PR URL; `--dry-run`;
  `--repo owner/name`. Strip a leading `#`. A URL
  (`https://github.com/<owner>/<name>/pull/<n>`) carries both the repo and the number. No PR
  given: use the current branch's PR (`gh pr view --json number -q .number`); if the branch has
  none, ask which PR to review.
- **Repo.** From the URL or `--repo`, otherwise
  `gh repo view --json nameWithOwner -q .nameWithOwner`. Below, `<repo>` is that value; pass
  `--repo <repo>` on every `gh` call when it's not the current directory's repo.
- **Load the PR:**
  `gh pr view <n> --repo <repo> --json number,url,title,author,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles`
- **Author guard.** If `author.login` equals `gh api user -q .login`, it's the user's own PR. Stop
  and point to a self-review skill such as `full-review` or `annotate-pr-changes` if the repo has
  one; continue only if the user insists. Merged or
  closed: ask before reviewing. Draft: review, and say so in the summary.
- **Work dir and diff.** `W=$(mktemp -d -t review-pr-<n>)`, then
  `gh pr diff <n> --repo <repo> > $W/pr.diff`. This file pins the reviewed commit (`headRefOid`):
  every line number in the review comes from it, so a push during the review can't shift anchors.
  If `gh pr diff` refuses (too large), diff locally after the fetch below:
  `git diff $(git merge-base <baseRefOid> <headRefOid>) <headRefOid> > $W/pr.diff`.
  An empty diff: stop and say so.
- **Head and base objects without a checkout.** In a local clone of `<repo>` (the current
  directory, or one the user names), run `git fetch origin <baseRefName> refs/pull/<n>/head` so
  `git show <headRefOid>:<path>`, `git grep <pattern> <headRefOid>` and the merge-base work. Never
  check out, switch, stash or reset: the working tree may be shared with other agents and hold
  their uncommitted work. Record `MB=$(git merge-base <baseRefOid> <headRefOid>)` for base-side
  reads, and `<clone>` as the clone's absolute path (or `none`: subagents then read files through
  `gh api`, and can't `git grep`).
- **File inventory** (the only view of the diff the main session reads):
  `node <skill>/scripts/numbered-diff.mjs --diff-file $W/pr.diff --files-only`
- **Existing comments**, for deduplication in step 5. Save them, don't read them now:
  ```bash
  gh api --paginate repos/<repo>/pulls/<n>/comments \
    --jq '.[] | {path, line, user: .user.login, body: .body[0:200]}' > $W/existing-review-comments.jsonl
  gh api --paginate repos/<repo>/issues/<n>/comments \
    --jq '.[] | {user: .user.login, body: .body[0:300]}' > $W/existing-issue-comments.jsonl
  ```

## 2. Diff map and context brief (two subagents in parallel, wait for both)

The layer reviewers depend on both, so spawn both subagents in one message, in the foreground. The
context brief is `pr-review-fast`. The diff map is `pr-review-fast`, or `pr-review-standard` on a
large PR:

```
Write the diff map for PR #<n> in <repo>. Read <skill>/references/diff-map.md and follow it.
Inputs: head <headRefOid>, merge-base <MB>, work dir <W>, skill dir <skill>, local clone <clone>.
```

```
Write the context brief for PR #<n> in <repo>. Read <skill>/references/context-brief.md and
follow it. Inputs: head <headRefOid>, base <baseRefOid>, merge-base <MB>, head branch
<headRefName>, work dir <W>, skill dir <skill>, local clone <clone>.
```

- **Diff map** (`$W/diff-map.md`): reads the diff once so the layer reviewers don't each scan it.
  Per file: its kind (core, test, mechanical, doc...) and each hunk's head line range with a
  one-line summary. Plus the hot spots worth a close look and which files each layer should read.
- **Context brief** (`$W/brief.md`): intent, acceptance criteria, the PR's claims, the governing
  AGENTS.md files and topic docs, sources found and not found.

Read both: you need them to judge the findings.

## 3. Four layer reviewers (parallel)

Send one message with four Agent calls, run in the background:

| Layer       | Reference                          | Comment label      | `subagent_type`                        |
| ----------- | ---------------------------------- | ------------------ | -------------------------------------- |
| correctness | `references/layer-correctness.md`  | `Code correctness` | `pr-review-deep`                       |
| quality     | `references/layer-quality.md`      | `Code quality`     | `pr-review-fast` or `pr-review-standard` (see tiers) |
| intent      | `references/layer-intent.md`       | `Semantic Intent`  | `pr-review-deep`                       |
| complexity  | `references/layer-complexity.md`   | `Code complexity`  | `pr-review-deep`                       |

Each prompt:

```
You are the <layer> reviewer for PR #<n> in <repo>. Read <skill>/references/subagent-contract.md,
then <skill>/references/layer-<layer>.md, and follow both.
Inputs: head <headRefOid>, base <baseRefOid>, merge-base <MB>, diff file <W>/pr.diff,
diff map <W>/diff-map.md, brief <W>/brief.md, skill dir <skill>, local clone <clone>.
[File scope: <paths>   - only when splitting, see below]
```

Pass paths, never the diff text. The references hold the full instructions, so prompts stay short
and identical from run to run.

**Large PRs.** When the inventory reports more than ~2,500 changed lines outside generated files,
split the correctness and quality layers by file group (package or feature area, from the diff
map's routing) into two or three subagents each, with a `File scope:` line. Intent and complexity
stay whole: they read for the shape of the change, not every hunk.

While they run you have nothing to do. Wait for the completion notifications.

## 4. Verify

Each reviewer returns one JSON block (format in `references/subagent-contract.md`). A reviewer
that failed, died or returned `status: incomplete` gets named in the summary as not (fully)
reviewed. Never drop a layer silently: "0 findings" and "didn't run" are different results.

Verify before anything reaches GitHub:

- **Read the cited lines yourself** for every `critical` and `should_fix` finding:
  `git show <headRefOid>:<path> | sed -n '<a>,<b>p'`. Small and cheap. Check the quoted evidence
  is really there and the claim holds on its face.
- **Claims that depend on code elsewhere** (a caller passes null, a column is nullable, another
  path already handles it): batch them all into one `pr-review-deep` verifier subagent. Prompt:
  "For each claim, try to refute it by reading the code at <headRefOid> in <clone> (no
  checkout; use `git show` and `git grep`). Also say whether the PR introduces the behavior or it
  already existed at <MB>. Return per claim: confirmed / refuted / unsure, with file:line
  evidence."
- Refuted: drop. Unsure: drop, or keep as `consider` phrased as a question to the author when the
  question is worth their time.

## 5. Triage

- **Deduplicate.** The same issue from two layers on the same lines becomes one comment under the
  label that names the root cause. Different issues on the same line merge into one comment
  (GitHub shows them stacked otherwise).
- **Skip what's already raised** in `$W/existing-*.jsonl`: by a human (that thread is theirs), by
  a bot such as CodeRabbit, or by an earlier run of this skill (`🤖 Agent: **Code review`). On a
  re-review, mention in the summary which earlier findings now look fixed.
- **Cap.** No `nit` goes inline. Keep about eight inline comments at most, ranked critical >
  should_fix > consider, and correctness or intent before quality or complexity at equal
  severity. Cut the rest; the cut ones don't go anywhere.
- **Unanchored findings** (code outside the diff hunks, a missing requirement with no natural
  line, a PR-wide concern like "split this PR") go into the summary as one line each, with a
  blob link: `https://github.com/<repo>/blob/<headRefOid>/<path>#L<a>-L<b>`.
- **Praise.** Pick two to four `praise` lines from the reviewers. Specific beats generic: "tests
  cover the omitted-endDate case" beats "good tests".

## 6. Write

**Inline comment body.** Exact prefix line, then the review:

```
🤖 Agent: **Code review <label>**:
**<Severity>:** <the problem and its concrete consequence, 1-3 sentences>

<the proposal: what to change, concretely>
```

- Labels: `Code correctness`, `Code quality`, `Semantic Intent`, `Code complexity`.
- Severity words: `Critical`, `Should fix`, `Consider`. Critical means broken behavior, data loss
  or a security hole; Should fix means fix before merge; Consider is the author's call.
- Lead with the problem and what goes wrong ("an approved update without `endDate` clears the
  stored date"), not with a description of the code. Cite the rule for convention findings
  ("AGENTS.md: prefer function declarations at top level").
- A small, exact fix of the anchored lines can be a GitHub suggestion block. It replaces lines
  `start_line`..`line` (or just `line`) wholesale, so it must contain the full replacement text of
  exactly those lines, indentation included. Anything less precise goes in prose.
- Write like a colleague: plain words, no hedging on confirmed problems, no filler, no praise
  inside finding comments.

**Summary comment** (posted as its own PR comment, not tied to a line):

```
🤖 Agent: **Code review summary**:
<2-3 sentences: what the PR does, whether it delivers the ticket/spec, the biggest risk if any>

**What's good**
- <specific praise>

**Findings:** <k> inline comments (<a> correctness, <b> quality, <c> intent, <d> complexity), <x> critical.
- <unanchored finding, one line each, with blob link>

Reviewed against: <ticket id / spec path / AGENTS.md files>. <Layers not fully reviewed, if any.>
```

No approve or request-changes verdict, in words or as a review event: that call belongs to the
user.

## 7. Post

1. Write `$W/payload.json` with the Write tool (a JSON `\n` in a string is a real newline once
   parsed, which is what the body needs; `gh api -f body='...\n...'` would post a literal
   backslash-n):
   ```json
   {
     "commit_id": "<headRefOid>",
     "event": "COMMENT",
     "body": "🤖 Agent: Inline code review comments. Summary in the PR conversation.",
     "comments": [
       { "path": "src/a.ts", "line": 42, "side": "RIGHT", "body": "🤖 Agent: **Code review Code correctness**:\n**Should fix:** ..." },
       { "path": "src/b.ts", "start_line": 10, "start_side": "RIGHT", "line": 14, "side": "RIGHT", "body": "..." }
     ]
   }
   ```
   `event: "COMMENT"` is required: without it the review stays pending and only the user sees it.
2. Write the summary to `$W/summary.md`.
3. Validate, every time, because one bad anchor makes GitHub reject the whole review with a 422:
   `node <skill>/scripts/validate-review-anchors.mjs $W/payload.json --pr <n> --diff-file $W/pr.diff --repo <repo>`
   Fix and re-run until it prints `VALID` (or `NOTHING TO POST`, meaning summary only).
4. `--dry-run`: stop here. Show the validator preview, the summary text, and both file paths.
5. Otherwise post the review, then the summary:
   ```bash
   gh api --method POST repos/<repo>/pulls/<n>/reviews --input $W/payload.json --jq .html_url
   gh pr comment <n> --repo <repo> --body-file $W/summary.md
   ```

## 8. Report to the user

Briefly: the review and summary URLs (or the dry-run preview), the inline count per layer, how many
findings were dropped as refuted or unconfirmed, any layer that didn't fully run, and which context
sources were found or missing.
