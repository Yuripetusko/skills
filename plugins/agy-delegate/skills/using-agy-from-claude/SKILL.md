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
into the checkout or into agy's global config. The agent's `tools` list leaves out the subagent tools.
Task and implement jobs run as the same agent, and the hooks tell them apart. The hooks block these
calls:

- In every job: git commands that change repository state (commit, push, reset, checkout, stash,
  merge and the like), other AI CLIs (`claude`, `codex`, `gemini`, `agy`, `coderabbit`), and shell
  commands that name the job dir. If the job's `state.json` changes during the run, every call is
  blocked.
- In implement jobs: `gh` commands that write to GitHub, dependency installs and changes, MCP tool
  calls (`call_mcp_tool`), and file writes outside the worktree, outside `paths:`, or to ticket
  files, `MAP.md` and `SPEC.md`.
- In read-only jobs: every file write.

Task jobs can call the MCP servers configured in agy, because agy adds its MCP tools to an agent
whatever the agent's `tools` list says. A read-only task job loses MCP tools whose name has a write
verb as a word (`write_file`, `createIssue`, `delete`, `send`, `add` and the like) and keeps `list`,
`get`, `read`, `search`, `query`, `find`, `fetch` and `describe`. A name with neither kind is allowed and
logged in `hook.log` with the note `mcp-unclassified`. Task jobs can also run `gh` reads and writes and
dependency commands. In print mode agy 1.3.3 offered no browser tools, so a task job cannot drive a
browser.

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
- When the check is clean, the hook runs the verifier: a nested, read-only `agy -p` as the
  `delegate-verifier` agent on `gemini-3.8-flash-medium`, configured in `<dir>/agy-verifier/`. It
  reads the job's numbered diff, the brief, the applicable `AGENTS.md` files and
  [prompts/verifier-checklist.md](prompts/verifier-checklist.md), and returns PASS or FAIL with
  `file:line` findings. Its hook allows only `view_file`, `list_dir`, `find_by_name` and
  `grep_search` on the worktree, its input dir and its config dir, plus `finish`; MCP and every other
  tool are denied. A FAIL goes back to agy like gate findings and shares the 3 rounds. A run that
  gives no valid verdict (timeout, a non-zero exit or a kill even after a streamed result, an invalid
  result, a changed worktree) fails the round, and the job exits 17 without sending agy back, or 10
  when agy reported a quota or rate limit. Without
  the job's environment its hook denies every call, `finish` included. Its inputs are in
  `<dir>/verifier/input-<n>/`, its verdict in `<dir>/verifier/result-<n>.json`, and its hook
  decisions in `hook.log` with `role: verifier`. It checks conventions, not a full review: the
  caller still reviews the change. It took 62 to 118 s on small diffs, 264 s once live, and 56 to
  351 s on a 25-file diff. Its `--print-timeout` is 420 s.
- agy also stops mid-job, for example at a `wait` step while its own commands run. When the Stop
  input says `fullyIdle: false`, the hook runs no check and spends no round.
- Each check records the git tree it checked. After agy exits, the runner takes a verdict only from
  a check of this run on the tree agy left. When none covers it, the runner checks the tree itself
  once, gate and verifier: a Stop hook may have crashed or timed out (1080 s), agy may have edited
  after its last check, or no Stop came. That check failing or not running exits 17.
- A rerun in the same job dir keeps the first baseline and the earlier rounds, so findings an
  earlier execution added still count and the 3 rounds are shared.
- `report.md` opens with a "Gates" section. Its first line is the verdict: `GATE OK`, `GATE FAILED`,
  `GATE ERROR` or `GATE: not configured`, with the verifier's verdict when it ran. Then come the
  baseline, one line per round with the verifier's verdict and runtime, the findings sent back, the
  verifier's model, and the findings still open. `meta.json` keeps the verdict, the rounds and the
  verifier's verdict in `gate`.
- Without a config the report says `GATE: not configured`, and nothing is checked.
- agy's `--print-timeout` gets 72 extra minutes for gate rounds (4 Stop hooks at 1080 s: a 570 s
  check, a 450 s verifier run and 60 s for the diff). It is capped so the runner ends within 110
  minutes of its start, its own check and verifier run after agy exits included, and so the runner's
  kill timer allows at least one whole Stop hook run past `--print-timeout`. The cap applies to every
  job with a gate, at about 73 minutes. Whether hook time counts against `--print-timeout` is not
  measured yet. The runner's own kill timer allows for both.
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

Create the job with `node "$JOBS" new agy --label "<mode>: <a few words of the task>"`, in the
checkout the job runs in: the runner exits 18 for a job created in another one. It prints the
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

- **Model.** Default `gemini-3.8-flash-medium`. A gated trial ran one 25-file refactor once on
  each of `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` and `gemini-3.1-pro-high`. All three
  needed 2 rounds and ended with nearly the same diff. flash-high used 36% more tokens and
  silenced one type error with `@ts-expect-error`. pro-high used 84% more tokens and about 10 more
  minutes. Pass whatever the brief names; the runner checks it against `agy models` (exit 14 lists
  the valid ones).
- **Effort.** The model id carries it. agy's `--effort` works only with a bare family id such as
  `gemini-3.8-flash`, which `agy models` doesn't list. With a suffixed id agy exits with "conflicts",
  and flash rejects `xhigh` and `max`. The runner has no effort option.
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
| 10   | quota   | Quota or rate limit, for agy or its verifier. Another model, or later; a follow-up can resume the conversation |
| 11   | auth    | agy is not signed in. The user runs `agy` once in a terminal                   |
| 12   | timeout | The turn limit expired; any answer is partial and can be resumed               |
| 13   | missing | agy is not installed                                                           |
| 14   | model   | Model not available; the error lists the valid ones                            |
| 15   | denied  | agy was refused a permission it cannot get headless                            |
| 16   | busy    | Another write job is running in this checkout; `node "$JOBS" jobs` shows it    |
| 17   | gate    | The gate or the verifier still found problems after 3 rounds, or the verifier could not give a verdict for a reason other than quota. The Gates section in `report.md` lists them |
| 18   | setup   | The job rules or the gate baseline did not load, or the job was created in another checkout, so nothing was enforced. Report it; don't retry until it is fixed |
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

A job with a gate also shows what its Stop hook is doing. agy's stream has no hook events, so a gate
check of 2 to 6 minutes or a verifier run of 1 to 7 minutes would look like a stalled job. The hooks
write `progress.jsonl` and `tail` puts its lines between agy's steps. They cover each gate check and
verifier run at its start and its end, with the findings added and removed, the verifier's model and
pid, any timeout, and what the hook decided. A round is up to five lines, and none come from the
verifier's own tool calls:

```
gate round 1: lint and type-check started (stopped after 570s)
gate round 1: lint and type-check OK, 0 added, 0 removed (141s)
gate round 1: verifier started: gemini-3.8-flash-medium, pid 4242, stopped after 450s
gate round 1: verifier FAIL, 1 finding(s) (87s)
gate round 1: sent back to agy (1 of 3)
```

With `--every` these lines still print as they happen, and only agy's own steps are condensed. When
the runner checks the tree agy left after agy exits, its lines read `gate round 4 (runner, after agy
exited): ...`. Once the job ends, `jobs` shows the verifier next to the gate, for example
`gate OK · verifier PASS` or `gate FAILED · verifier FAIL (2)`. While it runs, `jobs` shows the
latest line under the job. The file is for display only; the runner never reads it for a verdict.

Jobs live in `~/.claude/delegate-jobs/<tool>-<date>-<time>-<rand>/` (override with
`DELEGATE_JOBS_DIR`). Each holds `meta.json`, `brief.md`, `input.jsonl`, `events.jsonl` (agy's
stream), `agy-stderr.log`, `out.md`, `err.log` and `report.md`. agy jobs also hold `agy/` (the job's
agent and hooks), `state.json`, `hook.log`, `progress.jsonl` (the gate's progress lines) and `loaded`,
the canary the hooks write when they start.
Implement jobs with a gate also hold `gate/`: the baseline and each round's snapshot and delta,
`agy-verifier/` (the verifier's agent and hook) and `verifier/` (each run's inputs, events and
verdict).
Old jobs are pruned after 7 days.
`jobs.mjs`, `clean-line.mjs`, `diff.mjs` and `gate.mjs` are shared with the `codex-delegate` plugin, which has identical
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
- The `init` event lists `sed_file`, `command_status` and `send_command_input`, but an agent whose
  `tools` names any of them fails before its first step with "tool ... not found in registry". The
  `/agents` preflight does not catch that. The `init` event lists every tool even when the agent has
  a `tools` allowlist.
- The registry rejects more names than those three. Probed one at a time, it also rejected
  `call_mcp_tool`, `list_resources`, `read_resource`, 22 browser tools (every one in the `init` list
  but `browser_subagent`, which was not probed), `delete_knowledge`, `list_permissions`,
  `manage_inbox`, `notebook_execution` and `wait_5_seconds`. An allowlist cannot name any of them.
- MCP tools survive an allowlist. An implement job on `delegate-implementer` made a `call_mcp_tool`
  step against a configured server and the call succeeded, and the model listed `call_mcp_tool`,
  `list_resources` and `read_resource` next to the allowlisted tools. The hook sees the call's args as
  `ServerName`, `ToolName`, `Arguments`, `toolAction` and `toolSummary`. Task jobs therefore need no
  agent of their own. Implement jobs lose the tool through a hook rule.
- Print mode offered no browser tools under any agent tried (allowlisted, no allowlist, default). This
  rests on the model's own tool list and on its answer when asked to call one. No browser tool step
  ran.
- A custom agent with no `tools` field lost `run_command` and the write tools under the runner's
  flags (`--dangerously-skip-permissions`, stream-json stdin, hooks). A probe agent with no `tools`
  field, run through plain `agy -p` without the flag or hooks, still had `run_command`. The cause was
  not isolated. Keep the allowlist.
- The `Stop` hook fires at the final answer (`terminationReason` `NO_TOOL_CALL`) and also mid-job at
  a `wait` step (`TERMINAL_STEP_TYPE`), after which agy carries on. In one run, a mid-job stop's hook
  time showed up in the result's `duration_seconds` and the final stop's did not.
- A `PreToolUse` deny holds under `--dangerously-skip-permissions`. The step ends in state ERROR and
  the model sees the reason. Empty output, a crash or a timeout also deny. The stream carries no
  hook events, which is why the hooks write `hook.log`.
- With `--json-schema`, the `result` event carries the parsed object in `structured_output`;
  `response` holds the same JSON with extra `toolAction` and `toolSummary` keys. The model delivers
  it through a `finish` tool call, so an agent with a `tools` list must name `finish`. Without it,
  a verifier run returned no `structured_output` and took 145 s instead of 49 s.
- Under `--dangerously-skip-permissions`, `view_file` reads files outside the workspace, so the
  verifier reads its input dir without an `--add-dir`. Its hook denies reads outside the worktree,
  that dir and its config dir: a probe verifier wandered into other job files and `~/.gemini`.
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
