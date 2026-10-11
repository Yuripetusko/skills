# Gate config

`delegate-jobs gate` compares lint and type-check findings before and after a delegated change. It
fails on any finding the change added. The commands come from the target repo's committed
`.agents/delegate-gate.json`, or from `--gate-config <path>`. Without either, the verdict is
`GATE: not configured`. The gate never passes on a repo it has no config for.

## Commands

```bash
delegate-jobs gate baseline --job <job> [--gate-config <path>] [--paths '<globs>']
delegate-jobs gate check --job <job> [--round <n>]
```

- `baseline` runs in the job's checkout, the `toplevel` in its `meta.json`. It works out the scope,
  runs the commands and writes `$JOB/gate/baseline.json`. The scope comes from `--paths`, else from the
  `paths:` header of `$JOB/brief.md`, else it is the whole repo.
- `check` reruns the command list recorded in the baseline, writes `after-<n>.json` and
  `delta-<n>.json`, and prints the verdict. `<n>` defaults to one more than the last round.
- Run `baseline` before the agent starts. Run it with installed dependencies.

| Exit | First line                | Meaning                                                              |
| ---- | ------------------------- | -------------------------------------------------------------------- |
| 0    | `GATE OK` / `GATE BASELINE` | No finding added, or the baseline was recorded                     |
| 1    | `GATE FAILED`             | Findings added, or a changed file is outside the baseline scope      |
| 2    | `GATE ERROR`              | A snapshot could not run, the baseline is missing, or the gate crashed |
| 3    | `GATE: not configured`    | No config file and no `--gate-config`                                |

After the first line, `check` lists each added finding as `+ <rule>  <file>:<line>:<col>  <message>`,
then each file outside the scope, the removed counts by rule, the stderr of any command that failed,
and the path of the delta file. A stale copy of `jobs.mjs` without `gate.mjs` next to it exits 2 with
nothing on stdout, so check the exit code first.

## The config file

```json
{
  "packages": ["apps/*", "packages/*"],
  "extraProjects": ["scripts"],
  "wholeRepo": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"],
  "links": [{ "from": "apps/web", "to": ["apps/storybook"] }],
  "env": {},
  "lint": {
    "command": ["pnpm", "--silent", "run", "lint", "--format=json", "--report-unused-disable-directives-severity=warn"],
    "cwd": "{dir}",
    "parser": "oxlint-json",
    "script": "lint",
    "timeoutSec": 600,
    "concurrency": 1
  },
  "typecheck": {
    "command": ["pnpm", "--silent", "run", "type-check", "{projects}", "--force", "--pretty", "false"],
    "parser": "tsc",
    "timeoutSec": 1200
  }
}
```

| Field                 | Default            | Meaning |
| --------------------- | ------------------ | ------- |
| `packages`            | workspace globs    | Globs for package dirs. Defaults to `workspaces` in the root `package.json`, or `packages:` in `pnpm-workspace.yaml`. Each dir with a `package.json` is a unit |
| `extraProjects`       | `[]`               | Dirs outside the packages that are type-check projects, such as a root `scripts/` with its own `tsconfig.json`. They get no lint command |
| `wholeRepo`           | `[]`               | Globs for files whose change affects every package: lockfile, root manifest, shared config |
| `links`               | `[]`               | Dependencies the manifests don't declare. The `to` units compile the `from` unit's sources, so they count as its dependents |
| `env`                 | `{}`               | Extra environment for every command. `NO_COLOR=1` is always set |
| `lint.command`        | required           | Argument array, run once per unit in scope. `{dir}` becomes the unit's repo-relative dir and `{name}` its package name |
| `lint.cwd`            | `.`                | Working dir, relative to the repo root; takes `{dir}`. Relative paths in the output resolve against it |
| `lint.parser`         | required           | `oxlint-json` |
| `lint.script`         | none               | Only units whose `package.json` has this script get a lint command |
| `lint.timeoutSec`     | `600`              | Per command |
| `lint.concurrency`    | `1`                | Lint commands run at the same time |
| `typecheck.command`   | required           | Argument array, run once. An entry that is exactly `{projects}` becomes the in-scope units that have a `tsconfig.json`. For a whole-repo scope it becomes nothing, and `tsc -b` uses the root `tsconfig.json` |
| `typecheck.cwd`       | `.`                | As for lint |
| `typecheck.parser`    | required           | `tsc`. The command needs `--pretty false` |
| `typecheck.timeoutSec`| `900`              | |
| `notes`               | none               | Ignored |

A config needs `lint`, `typecheck` or both. Commands run without a shell, each in its own process
group, and a timeout kills the whole group. Type-check runs before lint in both snapshots, because
`tsc -b` writes the `dist/` output that type-aware lint can read.

## Scope

1. A changed file belongs to the unit with the longest matching dir. Files outside every unit, such as
   root docs, have no gate command and are ignored.
2. Each `paths:` entry matches the way `wt-finish` matches it: a directory covers everything below it,
   anything else is a glob. The units that own matching files are the seeds. So is the unit that owns
   the entry's literal prefix, so a file that doesn't exist yet still counts.
3. The scope is the seeds plus their transitive dependents, through every kind of workspace
   dependency and through `links`. A change to a package can change type-check and type-aware lint
   results in the packages that import it.
4. An entry that matches `wholeRepo`, or no `paths:` at all, makes the scope the whole repo.

`check` then sorts every file changed since the baseline:

- In a scope unit: compared as usual.
- Matching `wholeRepo`, or in a unit outside the scope: reported as outside the baseline scope, exit 1.
  The baseline never ran there, so every existing finding would look new.
- Outside every unit: listed as `unowned` in the delta file and ignored.

The changed files come from git. The baseline records the working tree, untracked files included, as
a tree object built in a scratch index under `$JOB/gate/`. `check` builds another and diffs the two
with rename detection. Gitignored files don't count, and the real index is never touched.

## Delta

- Each finding is keyed by tool, rule, repo-relative file, severity and message, with no line or
  column. The rule is oxlint's `code` or the `TS` code. oxlint's unused-disable-directive diagnostic
  has no code and gets the rule `unused-disable-directive`.
- Messages are trimmed line by line, and the worktree path is removed from them. tsc's indented
  continuation lines are part of the message.
- The keys are compared as multisets. A file with three identical findings where the baseline had two
  has one added. A finding that only moved lines is not new. A renamed file keeps its baseline
  findings under the new name.
- Any added finding fails the check, even when more were removed.

## When a snapshot could not run

The snapshot fails, and `baseline` or `check` exits 2, when any command:

- could not start, timed out, or was killed by a signal;
- exited with a status its parser doesn't expect: oxlint 0 or 1, tsc 0, 1 or 2;
- printed output that doesn't parse. For lint that is anything but JSON with a `diagnostics` array.
  For tsc it is any line that is neither a diagnostic nor an indented continuation;
- for tsc, exited non-zero with no diagnostics, or printed a file-less `TS5xxx` or `TS6053` error.
  Those mean a project or option is broken and nothing was checked.

A baseline that could not run makes every later `check` exit 2.

## Files in `$JOB/gate/`

| File             | Holds |
| ---------------- | ----- |
| `baseline.json`  | Repo root, config path and content, `head`, the snapshot `tree`, `scope` (`whole`, `reason`, `paths`, `seeds`, `units`), the command list (`plan`), per-command results, `findings` and `countsByRule` |
| `after-<n>.json` | The check snapshot: per-command results, `findings`, `countsByRule` |
| `delta-<n>.json` | `verdict` (`ok`, `failed`, `error`, `not configured`), `exitCode`, `complete`, `added`, `removed`, `countsByRule` (added and removed per rule), `outsideScope`, `unowned`, `changed`, `renames`, and on an error `errors` plus `stderr` by command |

Each command result records `id`, `argv`, `cwd`, `status`, `signal`, `durationMs`, `stderrTail`,
`error` and the number of findings, so a slow or broken gate shows up in the job dir.
