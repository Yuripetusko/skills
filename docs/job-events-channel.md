# Proposal: push delegate job events into the orchestrating session


Status: idea, not built.

Today an orchestrating session learns about a running Codex or agy job in two ways. It can start the
Monitor tool on `node ~/.claude/delegate-jobs/jobs.mjs tail --next -f`, or it waits for the relay
subagent's final answer. Monitor has to be started by hand for each job and expires after 30 minutes
at most.

The simplest route is a **plugin monitor** (`experimental.monitors` in `plugin.json`, or
`monitors/monitors.json`). Claude Code runs the monitor's command as a background process for the
session, and every stdout line becomes a notification. A `jobs.mjs watch` command would do it:

- It polls `~/.claude/delegate-jobs/*/meta.json` and prints one line when a job starts and one when
  it ends, with the exit code and verdict.
- It keeps only jobs whose `session` matches its own `CLAUDE_CODE_SESSION_ID`, which `meta.json`
  already records.
- It runs with `when: "always"`, taking a per-session lock file so that installing both plugins
  doesn't double the events.

To check first:

- Does the monitor process get `CLAUDE_CODE_SESSION_ID`?
- Does `on-skill-invoke:<skill>` fire when a subagent preloads the skill? If it does, the monitor
  could start only in sessions that delegate.
- How chatty can it be before Claude Code stops it?

A heavier alternative: Claude Code plugins can declare **channels**: an MCP server bundled in the plugin that injects
messages into the session (`channels` in `plugin.json`, bound to an entry in `mcpServers`). A
`delegate-jobs` channel would make job events arrive on their own:

- The server watches `~/.claude/delegate-jobs/*/meta.json`.
- It emits one message per state change: started, finished with its exit code and verdict, or lost.
  It could optionally emit one line per agy tool call, throttled.
- Every job's `meta.json` already records `session`, the `CLAUDE_CODE_SESSION_ID` of the session
  that dispatched the relay (subagents inherit it). The server sends each event only to that
  session.
- It would live in a small third plugin, so both `codex-delegate` and `agy-delegate` can use it,
  with no `userConfig` needed.

A channel that is not on Anthropic's allowlist, which ours would not be, only loads with
`--dangerously-load-development-channels plugin:<name>@<marketplace>`. That flag prompts for
confirmation, works only in interactive sessions, and `-p` ignores it. The monitor route above
avoids all of that.

Related: in `claude -p` a relay's background command is killed when the main turn ends. Background
sessions run by `claude daemon` may not have that limit. That is worth testing for CI-style use.

To check before building:

- How a session opts into a plugin channel: whether it needs a flag such as `--channels`, and whether
  it works in the desktop app.
- How injected messages are rate-limited, and whether they wake an idle session.
- Whether the MCP server learns which session it is attached to, so it can filter on `session`.
