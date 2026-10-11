# Upstream

Forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), directory
`plugins/codex`, tag `v1.0.6`, commit `db52e28f4d9ded852ab3942cea316258ae4ef346`.
Apache-2.0 (see `LICENSE` and `NOTICE`). The runtime under `scripts/` is modified. The plugin
parts are removed: slash commands, the rescue agent, hooks, the stop-review gate, session transfer,
and the detached task worker. `SKILL.md` and `references/` are rewritten. The subagents that
preload this skill live in the `codex-delegate` plugin's `agents/` folder.

Diff against upstream:

```bash
git clone --quiet https://github.com/openai/codex-plugin-cc /tmp/codex-plugin-cc
git -C /tmp/codex-plugin-cc checkout --quiet db52e28f4d9ded852ab3942cea316258ae4ef346
diff -ru /tmp/codex-plugin-cc/plugins/codex plugins/codex-delegate/skills/using-codex-from-claude
```

Upstream's `tests/` suite no longer matches the trimmed fork: commands, hooks and transfer are gone.
Its runtime tests (review, task, status, cancel against a fake `codex` binary) are still the best
template for regression tests. They passed against the fork before the trim.
