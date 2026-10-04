# Diff map

You read the pull request's diff once so four layer reviewers (correctness, quality, intent,
complexity) don't each have to. They start from your map and open only the hunks routed to them,
so the map decides where their attention goes: make it accurate and make the hot spots count.

Read-only: no edits except writing the map file, no posting, no `git checkout`/`switch`/`stash`/
`reset` (the working tree may be shared with other agents).

## Steps

1. **Hunk ranges, no code:**
   `node <skill>/scripts/numbered-diff.mjs --diff-file <W>/pr.diff --hunks`
   This gives every file's hunks as head (`R`) and base (`L`) line ranges, with generated files
   marked.
2. **Read the hunks** of every non-generated file, a few files at a time:
   `node <skill>/scripts/numbered-diff.mjs --diff-file <W>/pr.diff <path> [<path> ...]`
   Skip `[generated]` files. When many files share one mechanical change (an import path rename,
   a renamed identifier, a copy edit), read two or three of them and summarize the rest as a
   group.
3. **Classify each file:** `core` (behavior lives here), `test`, `mechanical` (no behavior change:
   renames, moves, formatting, wiring one line), `doc` (READMEs, plans, specs, ADRs), `copy`
   (message catalogs, user-facing strings), `migration`, `generated`.
4. **Write the map** to `<W>/diff-map.md` and return the same text as your final message.

## The map

```markdown
# PR #<n> diff map

## Files
### <path> (+a -d) [core]
- R40-52: <what changed in this hunk, one line, in behavior terms>
- R88-90: <...>
### <path> (+a -d) [test]
- R10-60: <which cases the new tests cover>
### Mechanical group (+a -d, 14 files) [mechanical]
- <what the shared change is>; files: <paths>

## Hot spots
- <path>:R40-52: <why it deserves a close look: changed condition, new query, removed guard,
  error path, data write, concurrency, a behavior change for existing records>

## Routing
- correctness: <paths>
- quality: <paths>
- intent: <paths>
- complexity: <paths>
```

## Routing defaults

Adjust when the change calls for it, and say why in one line:

- **correctness:** core, migration, test files, plus the hot spots.
- **quality:** every non-generated file; mechanical groups by one sample.
- **intent:** core, test files (they show which requirements are covered), doc files that state
  the contract, copy that users read.
- **complexity:** core files and migrations.

Line ranges per hunk only, no code excerpts: the reviewers read the code themselves. Aim for a map
that fits in about one screen per 500 changed lines.
