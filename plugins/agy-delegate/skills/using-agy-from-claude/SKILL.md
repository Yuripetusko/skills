---
name: using-agy-from-claude
description: How a Claude subagent runs Google Antigravity (agy, Gemini) headless as a background job and relays its answer. Preloaded by the agy-delegate plugin's agy-agent and agy-implementer subagents; to use agy, delegate to one of those rather than loading this skill.
user-invocable: false
---

# Using agy from Claude

You hand one job to Google's Antigravity CLI (`agy`) and relay its answer to the agent that delegated
to you. The agent definition that preloaded this skill says which mode you run: `task` (generic) or
`implement` (a scoped change in a worktree).

## Ground rules

- You are a relay. Never author changes yourself, never summarise, reorder or correct agy's answer,
  and never substitute your own answer for a missing one. The one thing you may add is the optional
  `Relay notes` section in section 5. The only state you change goes through this skill's helpers:
  the job directory, and in implement mode `wt-setup` and `wt-finish`.
- agy runs with `--dangerously-skip-permissions` in your current directory. The user accepts that.
  What limits it is the job rules below, the brief's scope, the runner's report of what agy touched,
  and the delegating agent's checks afterwards.
- Never pass on agy's claim that tests or checks pass as verified. Verification belongs to the
  delegating agent; you report what changed.
- One write job per checkout at a time. The runner refuses a second one (exit 16). Jobs in other
  worktrees run in parallel.

## Job rules

The runner writes an agy config for each job to `<dir>/agy/`: a main agent, `delegate-implementer`,
and hooks. It launches agy with `--add-dir <dir>/agy --agent delegate-implementer`, so nothing goes
into the checkout or into agy's global config. The agent has no subagent, browser or MCP tools. The
hooks block these calls:

- In every job: git commands that change repository state (commit, push, reset, checkout, stash,
  merge and the like), other AI CLIs (`claude`, `codex`, `gemini`, `agy`, `coderabbit`), and shell
  commands that name the job dir. If the job's `state.json` changes during the run, every call is
  blocked.
- In implement jobs: `gh` commands that write to GitHub, dependency installs and changes, and file
  writes outside the worktree, outside `paths:`, or to ticket files, `MAP.md` and `SPEC.md`.
- In read-only jobs: every file write.

agy sees the reason for each block. The runner's report lists them under "blocked by job rules", and
`<dir>/hook.log` has every decision. Matching a command line stops accidents, not intent: a script
file still runs a blocked command, so the scope check and the caller's review stay.

## Lint and type-check gate

Implement jobs check lint and type-check inside agy's loop when the checkout has a gate config,
`.agents/delegate-gate.json`. The format is in [references/gate-config.md](references/gate-config.md).

- Before agy starts, the runner records a baseline with `gate baseline`. It needs installed
  dependencies. On a 12-package pnpm monorepo it took about 2.5 minutes, and 6 with cold caches. A
  baseline that cannot run fails the job with exit 18, and agy never starts.
- Each time agy tries to finish, a Stop hook runs `gate check`. The findings the change added, and
  any changed file outside the baseline's scope, go back to agy with the instruction to fix them
  without suppressing them. agy gets 3 such rounds. If the 4th check still fails, the hook lets agy
  stop and the job exits 17 (`gate`).
- A check that cannot run, a Stop hook that crashes or times out (600 s), or a run that ends without
  any check also exits 17. Only a clean check from this run counts.
- `report.md` opens with a "Gates" section. Its first line is the verdict: `GATE OK`, `GATE FAILED`,
  `GATE ERROR` or `GATE: not configured`. Then come the baseline, one line per round and the findings
  still added. `meta.json` keeps the verdict and the rounds in `gate`.
- Without a config the report says `GATE: not configured`, and nothing is checked.
- agy's `--print-timeout` gets 40 extra minutes for gate rounds (4 checks at the hook's 600 s
  timeout), capped so the runner ends within 110 minutes of its start. Whether hook time counts
  against `--print-timeout` is not measured yet. The runner's own kill timer allows for both.
- `--gate-config <path>` on `run` points at a config outside the checkout, for tests.

## Runtime

Every Bash call starts a fresh shell. Begin each call with:

```bash
SKILL="${CLAUDE_SKILL_DIR}"
JOBS="$SKILL/scripts/jobs.mjs"; AGY="$SKILL/scripts/agy-run.mjs"
```

Claude Code writes this skill's directory into the first line when it loads the skill. If that line
shows a variable name instead of a path, use the "Base directory for this skill" path instead.

Work in the directory you were started in, or in the brief's `cwd:` when it has one: then begin
every Bash call with `cd "<cwd>" &&`. The job and agy run in that checkout.

## 1. Job directory and brief

Create the job with `node "$JOBS" new agy --label "<mode>: <a few words of the task>"`. It prints the
directory; carry the literal path forward. Save the brief exactly as you received it to
`<dir>/brief.md` with a quoted heredoc. Add nothing: the runner puts agy's preamble in front of it.

A brief may start with header lines, then a blank line and the task. Read them yourself; leave
them in the saved brief, where agy sees `paths:` too.

| Header             | Means                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| `cwd: <path>`      | Run in that checkout instead of your own directory (any mode)              |
| `base: <ref>`      | Reset this worktree to `<ref>` before agy starts (Agent worktrees are cut from `main`) |
| `install: yes`     | Run the repo's `setup-worktree` script (one at a time per machine), or a frozen install |
| `install: deps`    | Only a frozen dependency install: enough for lint and type-check, no env files |
| `paths: <p> <p>…`  | Paths or globs agy may change, separated by spaces; an entry with spaces goes in double quotes. Required for implement; ask for it if missing |
| `commit: <msg>`    | Commit agy's changes with this message when they stay inside `paths`       |
| `model: <id>`      | agy model to use                                                            |
| `timeout: <dur>`   | agy's turn limit, e.g. `45m`                                                |

## 2. Model and timeout

- **Model.** Default `gemini-3.8-flash-high`. Use `gemini-3.8-flash-medium` when the brief calls the
  edit trivial, and `gemini-3.1-pro-high` when it calls for harder reasoning. Pass whatever the brief
  names; the runner checks it against `agy models` (exit 14 lists the valid ones). The model id
  carries the effort, so there is no separate effort flag.
- **Timeout.** Default `30m`, capped at `110m`, so agy stops before the 2 h Bash limit.

## 3. Implement mode: prepare the worktree

Only when the brief has `base:` or `install:`, or when the checkout has `.agents/delegate-gate.json`
but no `node_modules`. The gate needs installed dependencies, so in that last case pass
`--install deps` even when the brief has no `install:`. Run in the foreground with `timeout: 600000`:

```bash
node "$JOBS" wt-setup [--base <ref>] [--install | --install deps]
```

It refuses a main checkout (pass `--allow-main` only if the brief says so) and a worktree with
uncommitted changes. If it fails, or the install asks for input, stop and reply with its output.

## 4. Launch once, in the background

Use a single Bash call with `run_in_background: true` and `timeout: 7200000`:

```bash
node "$JOBS" exec "<dir>" --write -- node "$AGY" run --job-dir "<dir>" --mode <task|implement> [--model <id>] [--timeout <dur>]
```

- Keep `--write`, except for a `task` that the brief says is read-only: there drop `--write` and add
  `--read-only` to `run`.
- Do not redirect anything. `exec` writes agy's answer to `<dir>/out.md` and the runner's log to
  `<dir>/err.log`, and prints one progress line per tool call to the call's own output. That output
  is what the user sees in the app's background-task panel.
- Then end your turn with one plain-text line: the mode, `<dir>`, and `node "$JOBS" tail <job>`.
  You are pausing, not finishing: that line is not your report, and plain text at the end of a run
  is not delivered to your caller anyway. Do not call `SubagentHandback` now: it ends your run and
  can be used only once. You are re-invoked when the command exits. Do not poll, sleep, tail, or
  call `status` in the meantime.

## 5. When the command exits

Your reply below is your one final report. Do everything else first, including `wt-finish` in
implement mode, then deliver the whole reply in a single `SubagentHandback` call when you have that
tool; without it, end your run with the reply as plain text.

`<dir>/out.md` is agy's final answer. The runner drops waiting-status lines such as "I am waiting for
the type-check" from its start; `events.jsonl` keeps the raw text. Relay `out.md` as it is.

`<dir>/report.md` is the runner's report: the exit reason, the files agy wrote with its edit tools
(flagging gitignored paths and paths outside the checkout), every shell command it ran, the calls the
job rules blocked, `git status` after the run, and any processes it left running that the runner
stopped.

**Relay notes (optional).** Any reply may end with one `Relay notes` section, after everything above.
It holds only flags you read in `report.md` (in implement mode also `wt-finish`'s output): commands
that were blocked or denied, calls to other AI tools, and files written outside `paths:` or the
checkout. Write one short line per flag and quote the report. Leave the section out when nothing
needs flagging. Never summarise, judge or correct agy's answer in it.

- **Exit 0.** Reply with a header line, `agy <mode> · <job> · <model>`, then `<dir>/out.md`
  verbatim, then `report.md` verbatim.
- **Implement mode, after exit 0.** First run
  `node "$JOBS" wt-finish --job "<dir>" --paths '<the paths: value as written>'`, adding
  `--message "<commit>"` when the brief has `commit:`. Its first line is the scope verdict:
  `SCOPE OK` or `SCOPE VIOLATION`. Your header line leads with the verdicts:
  `agy implement · <job> · <model> · <gate verdict> · <scope verdict>`, plus the commit sha if one
  was made. The gate verdict is the first line under `## Gates` in `report.md`. Then give
  `wt-finish`'s full output, then `out.md` and `report.md`. A violation (exit 2) commits nothing, and
  you revert nothing: the caller decides.
- **Exit 17 (gate).** agy finished, but the gate still failed or could not run. Run `wt-finish` as
  above but without `--message`, so nothing is committed. Reply with
  `agy implement failed the gate (exit 17) · <job> · <model> · <gate verdict> · <scope verdict>`,
  then `wt-finish`'s output, then `out.md` verbatim (agy's answer is complete, not partial), then
  `report.md`.
- **Any other non-zero exit.** Reply with `agy <mode> failed (exit <code>: <label>) · <job>`, then
  `report.md`, then the last 15 lines of `<dir>/agy-stderr.log`. If `out.md` has text, include it,
  labelled partial. Give no substitute answer, and skip `wt-finish`.

| Exit | Label   | Meaning and what to say                                                        |
| ---- | ------- | ------------------------------------------------------------------------------ |
| 2    | failed  | agy or model error, or agy bound to another directory than yours               |
| 3    | empty   | agy reported success with no answer                                            |
| 10   | quota   | Quota or rate limit. Another model, or later; a follow-up can resume the conversation |
| 11   | auth    | agy is not signed in. The user runs `agy` once in a terminal                   |
| 12   | timeout | The turn limit expired; any answer is partial and can be resumed               |
| 13   | missing | agy is not installed                                                           |
| 14   | model   | Model not available; the error lists the valid ones                            |
| 15   | denied  | agy was refused a permission it cannot get headless                            |
| 16   | busy    | Another write job is running in this checkout; `node "$JOBS" jobs` shows it    |
| 17   | gate    | The gate still found added findings after 3 rounds, or could not run. The Gates section in `report.md` lists them |
| 18   | setup   | The job rules or the gate baseline did not load, so nothing was enforced. Report it; don't retry until it is fixed |
| 128+ | signal  | Cancelled or killed                                                            |

## Messages from the delegating agent

- **"cancel"**: run `node "$JOBS" cancel <job>` and confirm. It stops agy and the commands it
  started. Stopping a background subagent does not stop its background command, so cancellation
  always goes through you or `jobs.mjs`.
- **A follow-up**: create a new job directory for the new brief, and launch it under the same rules
  with `--resume <conversation id>` taken from the previous `report.md`.

## Watching progress

Anyone can find a running job, with no need to know its directory. That includes the delegating
agent and the user.

```bash
node ~/.claude/delegate-jobs/jobs.mjs jobs     # running and recent jobs, all checkouts, Codex too
node ~/.claude/delegate-jobs/jobs.mjs tail [<job>] [-f]
node ~/.claude/delegate-jobs/jobs.mjs cancel <job>
```

Inside Claude Code the plugin puts `delegate-jobs` on the Bash `PATH`, the same script without the
`node` prefix (`delegate-jobs jobs`, `delegate-jobs tail <job>`). An orchestrating Claude session can
have progress pushed to it: right after dispatching a relay, start the Monitor tool on
`delegate-jobs tail --next -f --every 2m`. It sends one summary line per two minutes (steps since the
last line, and the latest one) and then the job's outcome. Drop `--every` to get every step, which
costs the watching agent more context. Use `tail <job> -f` when the job is already known.

Jobs live in `~/.claude/delegate-jobs/<tool>-<date>-<time>-<rand>/` (override with
`DELEGATE_JOBS_DIR`). Each holds `meta.json`, `brief.md`, `input.jsonl`, `events.jsonl` (agy's
stream), `agy-stderr.log`, `out.md`, `err.log` and `report.md`. agy jobs also hold `agy/` (the job's
agent and hooks), `state.json`, `hook.log` and `loaded`, the canary the hooks write when they start.
Implement jobs with a gate also hold `gate/`: the baseline and each round's snapshot and delta.
Old jobs are pruned after 7 days.
`jobs.mjs`, `diff.mjs` and `gate.mjs` are shared with the `codex-delegate` plugin, which has identical
copies. Each `new` copies them to `~/.claude/delegate-jobs/`, a path that does not depend on where the
plugin is installed.

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

## Measured on agy 1.3.3 (2026-10-11 and 12)

- `agy -p` works in the current directory, worktrees included, with no `--add-dir`. The runner
  stops if agy reports another directory. Root and nested `AGENTS.md` files load in print mode.
- `.agents/hooks.json` in a dir passed with `--add-dir` fires in print mode. Its hooks run in the
  dir that holds `hooks.json`, and `workspacePaths` lists the config dir first, so the hooks find the
  job through `AGY_DELEGATE_JOB`. `agy -p /hooks --output-format json` lists those hooks with their
  source file. Hooks named in an agent's frontmatter do not show up there.
- `--agent <name>` needs `mainAgent: true` in the agent file. An unknown name runs the default agent
  and exits 0. `agy -p /agents --output-format json` lists the agents agy can load. Both slash
  commands answer in about 3 s without calling a model, so the runner checks both before launch.
  Because workspace hooks fire under any agent, the canary proves the hooks ran, not which agent ran.
- A `PreToolUse` deny holds under `--dangerously-skip-permissions`. The step ends in state ERROR and
  the model sees the reason. Empty output, a crash or a timeout also deny. The stream carries no
  hook events, which is why the hooks write `hook.log`.
- `-p=` with `--input-format stream-json` reads the prompt from stdin as
  `{"event":"user","message":{"role":"user","content":"…"}}`, so the brief stays out of `ps`.
- A denied action exits 0 with status `SUCCESS`, an empty answer and `denied_actions`. An expired
  `--print-timeout` also exits 0 with `SUCCESS`, plus `print timeout … partial output` on stderr. An
  unknown model exits 1 with status `ERROR`. The runner turns all of these into the exit codes above.
- Without a sign-in, `agy -p` opens a browser login and waits 60 s. The runner checks with
  `agy models` first, which takes about 2 s and opens nothing.
- stdin that is not a TTY does not hang `agy -p`, whether it is a socket or an open pipe. The runner
  feeds it a file anyway.
- Shell commands run in their own process group and can outlive agy. The runner tracks agy's child
  processes and stops the ones that survive it.
- Two runs in separate worktrees at the same time worked.
