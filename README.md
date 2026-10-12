# Some Skills that I use

Collection of skills that I created or modified based on the existing public skills to fit my workflow

## Delegating to Codex and agy

This repo is a Claude Code plugin marketplace, `yuripetusko-skills`, with two plugins:

- **`codex-delegate`**: `codex-agent`, `codex-implementer` and `codex-advisor`, which hand work to
  OpenAI Codex.
- **`agy-delegate`**: `agy-agent` and `agy-implementer`, which hand work to Google Antigravity
  (`agy`, Gemini).

Each subagent is a thin Claude relay (sonnet, low effort). It saves the brief, launches one
background command, and relays the other model's answer verbatim when that command exits. Plugin
agents carry the plugin's name, so you dispatch them as `codex-delegate:codex-agent`,
`agy-delegate:agy-implementer`, and so on.

| Use                                 | When                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| A Claude subagent                   | The work needs this session's context or tools, or judgement you want to steer closely |
| `agy-delegate:agy-implementer`      | A scoped, mostly mechanical change in a worktree: renames, call-site updates, boilerplate, applying a written plan. Fast and cheap (Gemini 3.8 Flash) |
| `agy-delegate:agy-agent`            | Anything else you want agy to take. agy only hears "another agent launched you, report back at the end" |
| `codex-delegate:codex-implementer`  | A scoped change that needs real reasoning, in a worktree                      |
| `codex-delegate:codex-agent`        | Long reasoning-heavy work: planning, root causes, research, hard changes      |
| `codex-delegate:codex-advisor`      | An independent second opinion: review a diff, challenge a plan. Read-only     |

The implementers take header lines at the top of the brief:

- `paths:` (required): the paths or globs the delegate may change.
- `base: <sha>`: resets an Agent worktree (cut from `main`) to a PR head.
- `install: yes`: runs the repo's `setup-worktree` script, or a frozen install.
- `commit: <message>`: commits on the Claude side once the change stays inside `paths`.

Tests stay with the caller, who should never take the delegate's own "tests pass" at face value. So
do lint and type-check, unless the target repo has a gate config.

**Lint and type-check gate for agy.** When the target repo commits `.agents/delegate-gate.json`,
`agy-implementer` records lint and type-check findings before agy starts. A Stop hook checks again
each time agy tries to finish and sends any new findings back to agy, up to 3 times. Once lint and
type-check are clean, a second, read-only agy run checks the diff against a fixed checklist (true
`SAFETY:` comments, no behaviour change to fit a type, no cast laundering, no copied helpers, kept
`unknown` return types, no weakened tests) and the repo's `AGENTS.md` files. Its findings go back
to agy the same way. If findings remain, or the gate or the verifier can't give a verdict, the job
exits 17 (`gate`). The relay's report leads with the gate verdict: `GATE OK`, `GATE FAILED`,
`GATE ERROR` or `GATE: not configured`. The config format is in
[gate-config.md](plugins/agy-delegate/skills/using-agy-from-claude/references/gate-config.md).

**These gates are opinionated.** They grew out of one pnpm and turbo monorepo that uses oxlint and
`tsc -b`, so the gate parses those two tools' output, and the agy job rules block what went wrong
there: git state changes, other AI CLIs, dependency installs, writes outside `paths:`, and edits to
ticket files. The commands come from each repo's config, but other linters, other type checkers and
switching individual rules off aren't supported yet. Pull requests that make them configurable are
welcome.

**Permissions.** agy runs with `--dangerously-skip-permissions`, and Codex write jobs use its
`workspace-write` sandbox, the same trust as running Claude in auto mode with whole-project access.
Scope comes from the brief and from the checks afterwards:

- The agy runner reports every file agy wrote, flagging gitignored paths and paths outside the
  checkout, plus every command it ran and any process it left behind.
- `wt-finish` refuses to commit changes outside `paths`.
- Only one write job runs per checkout at a time; parallel jobs in separate worktrees are fine.

**Watching progress.** Every job, Codex or agy, gets a directory under `~/.claude/delegate-jobs/`.
The relay's background command prints one line per tool call or progress event, and those lines show
up in the app's background-task panel. Inside Claude Code, both plugins put `delegate-jobs` on the
Bash `PATH`. From your own terminal, use the copy every job refreshes:

```bash
node ~/.claude/delegate-jobs/jobs.mjs jobs          # running and recent jobs, all checkouts
node ~/.claude/delegate-jobs/jobs.mjs tail [<job>] -f
node ~/.claude/delegate-jobs/jobs.mjs cancel <job>
```

For the orchestrating session itself, start the Monitor tool on
`delegate-jobs tail --next -f --every 2m` right after dispatching. It sends one summary line every two
minutes and then the job's outcome, which keeps the orchestrator's context small. Drop `--every` to
get every step. An agy job with a gate also prints a few lines per round as its Stop hook starts and
finishes each lint and type-check run and verifier run, so a long check doesn't look like a stall. The
lines give the findings added, the verifier's model and any timeout, and `--every` doesn't condense
them. `jobs` shows the verifier verdict beside the gate verdict.

`jobs.mjs`, `diff.mjs` and `gate.mjs` are shared by both plugins, with an identical copy in each; check them with
`cmp plugins/agy-delegate/skills/using-agy-from-claude/scripts/jobs.mjs plugins/codex-delegate/skills/using-codex-from-claude/scripts/jobs.mjs`
(and the same for `diff.mjs` and `gate.mjs`). Each new job refreshes the copies in `~/.claude/delegate-jobs/`.
`delegate-jobs diff --job <job>` writes a numbered diff, the changed files and the applicable
`AGENTS.md` files for a job's change; `--pr <n>` does the same for a GitHub PR.

**Install.** Add the marketplace from this checkout, then install both plugins:

```bash
claude plugin marketplace add ~/Sites/skills
claude plugin install codex-delegate@yuripetusko-skills
claude plugin install agy-delegate@yuripetusko-skills
```

A marketplace added from a local path loads its plugins in place. Edits in this checkout apply at the
next session or after `/reload-plugins`, with no update step, and whatever branch is checked out is
what loads. To track pushed commits instead, add `Yuripetusko/skills` and run
`claude plugin marketplace update yuripetusko-skills` to pull changes. The plugins set no `version`,
so every commit counts as an update. On a fresh CI machine, run the add and install commands in the
job, or load a checkout with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`.

Two limits:

- In `claude -p`, background work is killed when the main turn ends. In one test the relay was also
  not re-invoked after its command finished. The relays are built for interactive sessions.
- The plugins don't install Codex or agy. Their CLIs must already be installed and signed in on the
  machine.

Next step for agy: [an Antigravity plugin with guard hooks](docs/agy-plugin-phase2.md) (proposal).
