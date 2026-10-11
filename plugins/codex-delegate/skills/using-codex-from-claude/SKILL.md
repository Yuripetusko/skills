---
name: using-codex-from-claude
description: How a Claude subagent runs OpenAI Codex (GPT-6) as a background job and relays its answer. Preloaded by the codex-delegate plugin's codex-agent, codex-implementer and codex-advisor subagents; to use Codex, delegate to one of those rather than loading this skill.
user-invocable: false
---

# Using Codex from Claude

You hand one job to OpenAI Codex and relay its answer to the agent that delegated to you. The agent
definition that preloaded this skill says which modes you may use; everything else is here.

## Ground rules

- You are a relay. Never analyse the code yourself, never author changes, never summarise or reorder
  Codex's output, and never substitute your own answer for a missing one. The one thing you may add
  is the optional `Relay notes` section in section 6. The only state you change goes through this
  skill's helpers: the job directory, and in implementer mode `wt-setup` and `wt-finish`.
- One Codex job per relay, and one write job per checkout at a time. The runner refuses a second
  write job in the same checkout (exit 16). Read-only jobs, and jobs in other worktrees, run in
  parallel.
- Codex reasons deeply and slowly (minutes, sometimes tens of minutes). That is expected: it is why
  the delegating agent chose Codex for planning, adversarial review, hard root causes, independent
  verification of Claude's work, or comparing approaches.

## Runtime

Every Bash call starts a fresh shell, and shell variables do not survive between calls. Begin each
call with:

```bash
SKILL="${CLAUDE_SKILL_DIR}"
CODEX="$SKILL/scripts/codex-companion.mjs"; JOBS="$SKILL/scripts/jobs.mjs"
```

Claude Code writes this skill's directory into the first line when it loads the skill. If that line
shows a variable name instead of a path, use the "Base directory for this skill" path instead.

Work in the directory you were started in, or in the brief's `cwd:` when it has one: then begin
every Bash call with `cd "<cwd>" &&`. The job and Codex run in that checkout.

## 1. Pick the mode

| The brief asks for                                                                 | Mode                 |
| ---------------------------------------------------------------------------------- | -------------------- |
| A plain code review of the current changes, no particular focus                    | `review`             |
| A review with a focus, or a challenge to the approach or design of a diff          | `adversarial-review` |
| Anything else: a plan or decision to assess, root cause, research, alternatives    | `task`               |
| Codex itself making code changes, stated explicitly                                 | `task --write`       |
| A scoped change in a worktree, from `codex-implementer`                            | `task --write`, implementer mode (section 4) |

Review target for both review modes: by default the working tree if it has changes, otherwise the
branch against the default branch. Use `--scope working-tree`, `--scope branch` or `--base <ref>`
when the brief names a target. `review` takes no focus text; anything the brief wants emphasised
means `adversarial-review`. Material that is not in the diff (a plan, a design doc) belongs in a
`task` brief, by path or inline.

## 2. Write the brief

Create the job with `node "$JOBS" new codex --label "<mode>: <a few words of the task>"`. It prints
the job directory; carry its literal path forward. Save the brief exactly as you received it to
`<dir>/brief.md` with a quoted heredoc. For `task`, if the brief has
no output contract, append one: lead with the answer or findings, cite `file:line`, separate
verified facts from inferences, and list open questions. Add nothing else. Guidance for briefs that
need tightening: `references/prompting.md` next to this file.

## 3. Choose model and effort

- **Model.** Leave `--model` unset unless the brief names one; the default is `model` in
  `~/.codex/config.toml`. Allowed: `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna` (aliases
  `astra`, `sol`, `luna`). Anything else is rejected.
- **Effort.** Leave `--effort` unset unless the brief names one, or the ask is small and bounded (a
  few files, one focused question): then `--effort medium`. Unset, Codex uses
  `model_reasoning_effort` from `~/.codex/config.toml`. `low`, `high` and `xhigh` are accepted;
  `max` and `ultra` are rejected. The `Thread ready` line in `err.log` names the model and effort
  the run actually uses.

## 4. Write jobs (`--write`)

Codex edits the checkout you run in, which other agents may share. Run a write job only when the
brief asks for changes and names the files or area. Add to the brief: stay inside that scope, do not
touch or revert uncommitted changes outside it, and do not run long-running or external review tools
(CodeRabbit or other AI review CLIs), push, or open pull requests, even if the repository's
AGENTS.md or CLAUDE.md lists them, unless the brief asks for that. Review modes and `task` without `--write` are
read-only sandboxes.

**Implementer mode** (`codex-delegate:codex-implementer`). The brief may start with header lines, then a blank line
and the task: `cwd: <path>`, `base: <ref>`, `install: yes` (the repo's `setup-worktree`, one at a time
per machine) or `install: deps` (a frozen dependency install only), `paths: <paths or globs>`,
`commit: <message>`, `model:`, `effort:`. `paths:` is required; ask for it if missing. Its entries are separated by
spaces, and an entry that contains spaces goes in double quotes.

1. If the brief has `base:` or `install:`, prepare the worktree in the foreground with
   `timeout: 600000`: `node "$JOBS" wt-setup [--base <ref>] [--install | --install deps]`. It refuses a main checkout
   and a dirty worktree. `--install` runs the repo's `setup-worktree` script, or else a frozen
   install. If it fails or asks for input, stop and reply with its output.
2. Append the rules: `cat "$SKILL/prompts/implementer.md" >> "<dir>/brief.md"`.
3. Launch `task --write` as in section 5.
4. After exit 0, run `node "$JOBS" wt-finish --job "<dir>" --paths '<the paths: value as written>'`, adding `--message "<commit>"` when
   the brief has `commit:`. Codex's sandbox cannot write a worktree's git metadata, so committing
   happens here. Its first line is the verdict, `SCOPE OK` or `SCOPE VIOLATION`: put that line, and
   the commit sha if one was made, at the end of your reply's header line, then `wt-finish`'s full
   output, then Codex's answer. A violation (exit 2) commits nothing, and you revert nothing: the
   caller decides.

## 5. Launch once, in the background

- **Invoker.** Use the job directory's basename (for example `codex-YYYYMMDD-HHMMSS-XXXXXX`): `new`
  makes it unique, which made-up names are not. Pass it as `--invoker` on every call for that job.
  It gives the job its own Codex broker and scopes `--resume-last` to it.
- **Launch** with a single Bash call, `run_in_background: true`, `timeout: 7200000`. Always in the
  background, even for a small ask: a foreground Bash call is killed after 10 minutes, Codex runs
  routinely take longer, and you cannot predict which ones will.

  ```bash
  DIR=<job dir>; NAME=<invoker>
  node "$JOBS" exec "$DIR" -- node "$CODEX" task --invoker "$NAME" --prompt-file "$DIR/brief.md"
  # task --write:       node "$JOBS" exec "$DIR" --write -- node "$CODEX" task --write --invoker …
  # adversarial-review: node "$JOBS" exec "$DIR" -- node "$CODEX" adversarial-review --invoker "$NAME" [target flags] "$(cat "$DIR/brief.md")"
  # review:             node "$JOBS" exec "$DIR" -- node "$CODEX" review --invoker "$NAME" [target flags]
  ```

  Do not redirect anything. `exec` writes Codex's stdout to `<dir>/out.md` and its stderr to
  `<dir>/err.log`, records the job in the shared registry, takes the checkout's write lock for
  `--write`, and prints Codex's progress lines to the call's own output. That output is what the
  user sees in the app's background-task panel.
- Then end your turn with one plain-text line: the mode, `<dir>`, and `node "$JOBS" tail <job>`.
  You are pausing, not finishing: that line is not your report, and plain text at the end of a run
  is not delivered to your caller anyway. Do not call `SubagentHandback` now: it ends your run and
  can be used only once. You are re-invoked when the command exits. Do not poll, sleep, tail, or
  call `status` in the meantime.
- Never pass `--background`; the runtime rejects it.

## 6. When the command exits

Your reply below is your one final report. Do everything else first, including `wt-finish` in
implementer mode, then deliver the whole reply in a single `SubagentHandback` call when you have
that tool; without it, end your run with the reply as plain text.

The first line of `<dir>/err.log` reads `[codex] Job <id> (invoker …), log: <path>`.

**Relay notes (optional).** Any reply may end with one `Relay notes` section, after everything above.
It holds only flags you read in `err.log` (in implementer mode also `wt-finish`'s output): commands
that were blocked or denied, calls to other AI tools, and files written outside `paths:` or the
checkout. Write one short line per flag and quote the log. Leave the section out when nothing needs
flagging. Never summarise, judge or correct Codex's answer in it.

- **Exit 0.** Reply with a header line, `Codex <mode> · job <id> · full output: <dir>/out.md`, then
  the contents of `<dir>/out.md` verbatim.
- **Non-zero exit.** Reply with `Codex <mode> failed (exit <code>) · job <id>`, the last 15 lines of
  `err.log`, and the output of `node "$CODEX" status <id>`. Give no substitute answer. Exit 16 means
  another write job holds this checkout; `node "$JOBS" jobs` names it.
- If `err.log` says the model "is not supported when using Codex with a ChatGPT account", relaunch
  once with `--model sol` and say so in your reply.

## Messages from the delegating agent

- **"cancel"**: run `node "$CODEX" cancel <job-id> --invoker "$NAME"` and confirm. Stopping a
  background subagent does not stop its background command, so cancellation goes through you, or
  through `node "$JOBS" cancel <job>`, which anyone can run.
- **A follow-up to a `task`**: write the new brief to a file and launch
  `task --resume-last --invoker "$NAME" --prompt-file <file>` under the same launch rules. Review
  modes cannot be resumed; start a fresh run.

## CLI reference

`node "$CODEX" <subcommand>`; `--help` prints usage.

| Subcommand                                                      | Does                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `review [--scope working-tree\|branch] [--base <ref>]`          | Codex's built-in reviewer. No focus text.                                    |
| `adversarial-review [target flags] "<focus>"`                   | Challenge review of the diff with structured findings.                       |
| `task [--write] [--resume-last] [--prompt-file <f>] "<prompt>"` | Open-ended Codex turn. Read-only unless `--write`.                           |
| `status [<job>] [--all] [--wait --timeout-ms <ms>]`             | Jobs in this repo; `--wait` blocks until a job ends.                         |
| `result [<job>]`                                                | Stored output of a finished job.                                             |
| `cancel <job>`                                                  | Interrupts the Codex turn and kills the runner.                              |
| `setup`                                                         | Checks that the `codex` CLI is installed and authenticated.                  |

Common flags: `--invoker`, `--model`, `--effort`, `--json`.

| Outcome                                                              | Exit  | Job state                                                   |
| -------------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| Codex finished                                                       | 0     | `completed`                                                 |
| Codex reported a failed turn, or the app-server connection dropped   | 1     | `failed`                                                    |
| The runner got SIGTERM, SIGINT or SIGHUP; the Codex turn is stopped  | 128+n | `failed`, phase `terminated`                                |
| The runner was SIGKILLed or crashed                                  | —     | `failed`, phase `lost`, set by the next `status`/`result`   |

Read-only runs finish 30 s after Codex's final answer even while its internal subagent turns drain.
Write runs wait for the whole turn.

## Watching progress

Anyone can find a running job, with no need to know its directory. That includes the delegating
agent and the user. Each registry entry is the job directory.

```bash
node ~/.claude/delegate-jobs/jobs.mjs jobs     # running and recent jobs, all checkouts, agy too
node ~/.claude/delegate-jobs/jobs.mjs tail [<job>] [-f]
node ~/.claude/delegate-jobs/jobs.mjs cancel <job>
```

Inside Claude Code the plugin puts `delegate-jobs` on the Bash `PATH`, the same script without the
`node` prefix (`delegate-jobs jobs`, `delegate-jobs tail <job>`). An orchestrating Claude session can
have progress pushed to it: right after dispatching a relay, start the Monitor tool on
`delegate-jobs tail --next -f --every 2m`. It sends one summary line per two minutes (steps since the
last line, and the latest one) and then the job's outcome. Drop `--every` to get every step, which
costs the watching agent more context. Use `tail <job> -f` when the job is already known.

Job directories live in `~/.claude/delegate-jobs/` (override with `DELEGATE_JOBS_DIR`) and are pruned
after 7 days. `scripts/jobs.mjs` and `scripts/diff.mjs` are shared with the `agy-delegate` plugin,
which has identical copies. Each `new` copies both to `~/.claude/delegate-jobs/`, a path that does
not depend on where the plugin is installed.

## Diff and applicable rules

`delegate-jobs diff` writes a clean diff of a change and the convention files that govern it. It
needs `git`, and `gh` (signed in) for `--pr`. A missing tool, a directory that is not a git checkout
or a base ref that does not resolve stops it with a message and a non-zero exit.

```bash
delegate-jobs diff --job <job> [--base <ref>] [--out <dir>]   # the job's worktree plus untracked files
delegate-jobs diff --pr <n> [--out <dir>]                      # a GitHub PR, read through gh
```

It writes four files to `--out` (default `<job dir>/diff/`, or a temp dir without `--job`):

- `diff.patch` is the full unified diff.
- `diff-numbered.txt` has the same hunks with base (`L`) and head (`R`) line numbers on every line.
  Generated and lock files get no hunks there.
- `files.json` has one entry per changed file: path, status, generated flag and owning package (the
  nearest `package.json`).
- `rules.json` lists the root `AGENTS.md` and every `AGENTS.md` between a changed file and the root
  (for a rename, between both its old and new path and the root), with byte sizes and an `over24kb`
  flag, because agy truncates a rules file at 24,000 bytes.

The base is `--base` (its merge-base with `HEAD`). Without it, a `--job` diff starts from the commit
the job started on, and anything else from the merge-base with `origin/main`, then `main`, then
`HEAD`. `--json` prints the whole result on stdout. For `--pr`, the packages and `AGENTS.md` files
come from the current checkout, not from the PR's head.

## Where things live

State is in `~/.claude/codex-skill/state/<repo-slug>-<hash>/` (override with
`CODEX_SKILL_DATA_DIR`):

- `state.json`: the job index (last 50 jobs).
- `jobs/<id>.json` and `jobs/<id>.log`: the job record and the progress log. The log shows Codex's
  answer as soon as it exists.
- `brokers/<invoker>.json`: one `codex app-server` broker per invoker.

A broker exits on its own when its owner Claude process is gone, after 5 min idle, or when its
app-server dies, and it is replaced after a `codex` CLI upgrade. When a broker is busy, a run falls
back to a private app-server.

## Troubleshooting

- **"model … is not supported when using Codex with a ChatGPT account"**: pass `--model sol`.
- **A job seems stuck**: `status <job>` checks that the runner pid is alive and marks dead runners
  `lost`. `tail` the job log for live progress.
- **Auth**: `setup`; the fix is `codex login`, which the user runs.
- **Leftover brokers**: `ps -axo pid,etime,command | grep 'app-server-broker.mjs serve'`. Kill only
  pids recorded in `brokers/*.json`, never `/Applications/ChatGPT.app`'s app-server.

Forked from openai/codex-plugin-cc; see `UPSTREAM.md`.
