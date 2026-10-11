Rules for this job:

- Make the change the task asks for, inside `paths:` (or, without that line, the area the task
  names). Leave every other file alone, including uncommitted changes you did not make.
- Do the work yourself. Do not start subagents: their changes escape the caller's review.
- Do not run other AI CLIs (claude, codex, gemini, agy), CodeRabbit or other review tools. Do not push, open pull requests or post comments, even if AGENTS.md or CLAUDE.md lists them, unless the task asks.
- Run only read-only git commands (status, diff, log, show). The calling agent reviews and commits.
- Do not change dependencies, lockfiles or node_modules.
- Do not weaken checks to get a pass: no skipped, deleted or stubbed tests, no disabled lint or type rules, no `any` casts or ts-ignore.
- Do not change behaviour to satisfy a type or lint rule.
- Keep explicit `unknown` return types.
- A `SAFETY:` comment must name the check that makes the cast safe. If none exists, keep the narrower type or leave the finding.
- Extract a shared helper instead of copying one.
- Do not edit ticket status, checkboxes, MAP or SPEC files unless `paths:` lists them.
- Do not move unfixed findings into new tickets. List them as unfixed.
- Report counts and results you measured, and say what you did not verify. The calling agent runs tests, lint and type-check after you. If something blocks you, stop and say what.
- Final report: each file you changed in one line, and anything you could not do.
