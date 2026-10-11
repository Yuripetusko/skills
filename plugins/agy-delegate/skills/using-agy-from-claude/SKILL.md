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
  and never substitute your own answer for a missing one. The only state you change goes through
  this skill's helpers: the job directory, and in implement mode `wt-setup` and `wt-finish`.
- agy runs with `--dangerously-skip-permissions` in your current directory. The user accepts that.
  What limits it is the brief's scope, the runner's report of what agy touched, and the delegating
  agent's checks afterwards.
- Never pass on agy's claim that tests or checks pass as verified. Verification belongs to the
  delegating agent; you report what changed.
- One write job per checkout at a time. The runner refuses a second one (exit 16). Jobs in other
  worktrees run in parallel.

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

Only when the brief has `base:` or `install:`. Run in the foreground with `timeout: 600000`:

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

`<dir>/report.md` is the runner's report: the exit reason, the files agy wrote with its edit tools
(flagging gitignored paths and paths outside the checkout), every shell command it ran, `git status`
after the run, and any processes it left running that the runner stopped.

- **Exit 0.** Reply with a header line, `agy <mode> · <job> · <model>`, then `<dir>/out.md`
  verbatim, then `report.md` verbatim.
- **Implement mode, after exit 0.** First run
  `node "$JOBS" wt-finish --job "<dir>" --paths '<the paths: value as written>'`, adding
  `--message "<commit>"` when the brief has `commit:`. Its first line is the verdict: `SCOPE OK` or
  `SCOPE VIOLATION`. Put that line, and the commit sha if one was made, at the end of your header
  line, then `wt-finish`'s full output, then `out.md` and `report.md`. A violation (exit 2) commits
  nothing, and you revert nothing: the caller decides.
- **Non-zero exit.** Reply with `agy <mode> failed (exit <code>: <label>) · <job>`, then `report.md`,
  then the last 15 lines of `<dir>/agy-stderr.log`. If `out.md` has text, include it, labelled
  partial. Give no substitute answer, and skip `wt-finish`.

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
stream), `agy-stderr.log`, `out.md`, `err.log` and `report.md`. Old jobs are pruned after 7 days.
`jobs.mjs` is shared with the `codex-delegate` plugin, which has an identical copy. Each `new` copies
it to `~/.claude/delegate-jobs/jobs.mjs`, a path that does not depend on where the plugin is
installed.

## Measured on agy 1.3.3 (2026-10-11)

- `agy -p` works in the current directory, worktrees included, with no `--add-dir`. The runner
  stops if agy reports another directory. Root and nested `AGENTS.md` files load in print mode.
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
