# Phase 2 proposal: an Antigravity plugin with guard hooks

Status: proposal, not built. Facts come from the Antigravity docs (`antigravity.google/docs/hooks/`,
`/docs/plugins/`) and the docs shipped with agy 1.3.3
(`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/`). Nothing hook-related has been
run yet.

## Why

Phase 1 limits agy from the outside. The brief scopes the work. The runner reports the files agy
wrote and the commands it ran. `wt-finish` refuses out-of-scope commits. All of that runs after agy
has acted. Hooks run inside agy's loop, so they can **prevent** the same mistakes:

- `git commit/push/reset/checkout` from agy;
- writes outside the worktree, or into `node_modules` and lockfiles;
- agy spawning its own subagents, which get their own worktrees and escape the scope check.

Worktree setup itself does not need a hook. It is already deterministic on the Claude side
(`wt-setup`), and agy has no session-start event.

## What agy 1.3.3 offers

- Hook events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. There is no
  SessionStart or UserPromptSubmit; the closest is `PreInvocation` with `invocationNum == 0`.
- `PreToolUse` matches tool names by regex (`run_command`, `write_to_file`, `replace_file_content`,
  `multi_replace_file_content`, `invoke_subagent`, …). It gets the call's args as JSON on stdin and
  answers `allow`, `deny`, `ask` or `force_ask` with a reason. `Stop` can return `continue` with a
  reason to send agy back to work.
- Locations: workspace `.agents/hooks.json`, global `~/.gemini/config/hooks.json`, or a plugin's
  `hooks.json`. Hooks from all sources are merged and run in sequence. A workspace plugin in
  `.agents/plugins/<name>/` loads without installing.
- A plugin's hooks fire whenever the plugin is enabled. agy has no `--plugin` flag, so "launch agy
  and ask it to use the plugin" applies to its skills, not to its hooks.

## Design

`agy-plugins/agy-delegate/` in this repo, holding `plugin.json`, `hooks.json` and
`scripts/guard.mjs`, installed globally.

- **Gating.** Global hooks fire in every agy session, including interactive ones. Each hook must
  return `allow` unless the session is a delegated job. Two signals, the first preferred:
  - `AGY_DELEGATE_JOB`: the runner already sets it to the job dir. This works only if hook processes
    inherit agy's environment, which is unverified.
  - A task file the runner writes before launch, e.g. `<git-dir>/agy-task.json` with the base sha and
    the `paths:` globs. The hook finds it from `workspacePaths[0]` in its input.
- **`PreToolUse` on `run_command`**: deny git commands that change state. A regex can be bypassed
  with `sh -c`, `git -C` or aliases, so this is a speed bump, and the Claude-side checks stay.
- **`PreToolUse` on the file-write tools**: deny paths outside the worktree, outside `paths:`, or
  under `node_modules` and lockfiles.
- **`PreToolUse` on `invoke_subagent` and `define_subagent`**: deny.
- **`Stop`**: optionally run a quick lint on the changed files and return `continue` once with the
  errors. Needs a loop guard.

`--dangerously-skip-permissions` stays. Hooks are guardrails, and `report.md` and `wt-finish` remain
the backstop.

## To verify on agy 1.3.3 before building

1. Do hooks fire in `-p` print mode, and does `Stop` run there? (`agy -p "/hooks"` lists the active
   hooks without spending quota.)
2. Does a `PreToolUse` `deny` hold under `--dangerously-skip-permissions`, and does it show up in
   `denied_actions`? If it does, the runner reports exit 15, which is the wanted outcome.
3. Do hook processes inherit agy's environment, which decides the gating signal? What are the
   file-write tools' argument names?
4. What happens when a hook exits non-zero, times out, or prints non-JSON: does it fail open?
5. Do new worktrees count as trusted, so that workspace `.agents/` hooks load? A target repo's own
   `.agents/hooks.json` would also load inside its worktrees.
6. Where does `agy plugin install` put the copy, and does a local-path entry load the plugin in
   place so edits need no reinstall?

For the `.agents/plugins/<name>/` layout itself, any existing skills-and-MCP plugin is a good template;
none of the ones I use define hooks.
