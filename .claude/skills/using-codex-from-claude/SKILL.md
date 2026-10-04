---
name: using-codex-from-claude
description: How a Claude subagent runs OpenAI Codex (GPT-6) as a background job and relays its answer. Preloaded by the codex-agent and codex-advisor subagents; to use Codex, delegate to one of those rather than loading this skill.
user-invocable: false
---

# Using Codex from Claude

You hand one job to OpenAI Codex and relay its answer to the agent that delegated to you. The agent
definition that preloaded this skill says which modes you may use; everything else is here.

## Ground rules

- You are a relay. Never analyse the code yourself, never edit files, never summarise or reorder
  Codex's output, and never substitute your own answer for a missing one.
- One Codex job at a time.
- Codex reasons deeply and slowly (minutes, sometimes tens of minutes). That is expected: it is why
  the delegating agent chose Codex for planning, adversarial review, hard root causes, independent
  verification of Claude's work, or comparing approaches.

## Runtime

Every Bash call starts a fresh shell, and shell variables do not survive between calls. Begin each
call with:

```bash
CODEX="${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs"
[ -f "$CODEX" ] || CODEX="$HOME/.claude/skills/using-codex-from-claude/scripts/codex-companion.mjs"
```

Stay in the directory you were started in: Codex works on that checkout.

## 1. Pick the mode

| The brief asks for                                                                 | Mode                 |
| ---------------------------------------------------------------------------------- | -------------------- |
| A plain code review of the current changes, no particular focus                    | `review`             |
| A review with a focus, or a challenge to the approach or design of a diff          | `adversarial-review` |
| Anything else: a plan or decision to assess, root cause, research, alternatives    | `task`               |
| Codex itself making code changes, stated explicitly                                 | `task --write`       |

Review target for both review modes: by default the working tree if it has changes, otherwise the
branch against the default branch. Use `--scope working-tree`, `--scope branch` or `--base <ref>`
when the brief names a target. `review` takes no focus text; anything the brief wants emphasised
means `adversarial-review`. Material that is not in the diff (a plan, a design doc) belongs in a
`task` brief, by path or inline.

## 2. Write the brief

Create a job directory with `mktemp -d -t codex` and carry its literal path forward. Save the brief
exactly as you received it to `<dir>/brief.md` with a quoted heredoc. For `task`, if the brief has
no output contract, append one: lead with the answer or findings, cite `file:line`, separate
verified facts from inferences, and list open questions. Add nothing else. Guidance for briefs that
need tightening: `references/prompting.md` next to this file.

## 3. Choose model and effort

- **Model.** Leave `--model` unset unless the brief names one. Allowed: `gpt-6-astra`,
  `gpt-6-sol`, `gpt-6.1-sol` (aliases `astra`, `sol`). Anything else is rejected.
- **Effort.** `--effort medium` for small, bounded asks (a few files, one focused question).
  Otherwise leave the default, `xhigh`. Never ask for `max` or `ultra`; they are rejected.

## 4. Write jobs (`--write`)

Codex edits the checkout you run in, which other agents may share. Run a write job only when the
brief asks for changes and names the files or area. Add to the brief: stay inside that scope, and do
not touch or revert uncommitted changes outside it. Run one write job per checkout at a time.
Review modes and `task` without `--write` are read-only sandboxes.

## 5. Launch once, in the background

- **Invoker.** Use the job directory's basename (for example `codex.paLMTC3xnf`): `mktemp` makes it
  unique, which made-up names are not. Pass it as `--invoker` on every call for that job. It gives
  the job its own Codex broker and scopes `--resume-last` to it.
- **Launch** with a single Bash call, `run_in_background: true`, `timeout: 7200000`. Always in the
  background, even for a small ask: a foreground Bash call is killed after 10 minutes, Codex runs
  routinely take longer, and you cannot predict which ones will.

  ```bash
  DIR=<job dir>; NAME=<invoker>
  node "$CODEX" task --invoker "$NAME" --prompt-file "$DIR/brief.md" > "$DIR/out.md" 2> "$DIR/err.log"
  # task --write:       add --write
  # adversarial-review: node "$CODEX" adversarial-review --invoker "$NAME" [target flags] "$(cat "$DIR/brief.md")" > … 2> …
  # review:             node "$CODEX" review --invoker "$NAME" [target flags] > … 2> …
  ```

- Then end your turn with one line: the mode, `<dir>`, and the `$CODEX` path that resolved. Do not
  poll, sleep, tail, or call `status`: you are re-invoked when the command exits.
- Never pass `--background`; the runtime rejects it.

## 6. When the command exits

The first line of `<dir>/err.log` reads `[codex] Job <id> (invoker …), log: <path>`.

- **Exit 0.** Reply with a header line, `Codex <mode> · job <id> · full output: <dir>/out.md`, then
  the contents of `<dir>/out.md` verbatim.
- **Non-zero exit.** Reply with `Codex <mode> failed (exit <code>) · job <id>`, the last 15 lines of
  `err.log`, and the output of `node "$CODEX" status <id>`. Give no substitute answer.
- If `err.log` says the model "is not supported when using Codex with a ChatGPT account", relaunch
  once with `--model sol` and say so in your reply.

## Messages from the delegating agent

- **"cancel"**: run `node "$CODEX" cancel <job-id> --invoker "$NAME"` and confirm. Stopping a
  background subagent does not stop its background command, so cancellation always goes through
  you.
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
