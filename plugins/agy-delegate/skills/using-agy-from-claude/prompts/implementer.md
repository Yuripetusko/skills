Rules for this job:

- Make the change the task asks for, inside the paths listed under `paths:` (or, without that line,
  the files and area the task names). Leave every other file alone, including uncommitted changes
  you did not make.
- Do the work yourself. Do not start subagents: their changes escape the caller's review.
- Do not run long-running or external review tools (CodeRabbit or other AI review CLIs), push, open
  pull requests, or post comments, even when the repository's AGENTS.md or CLAUDE.md lists them as
  validation steps, unless the task asks for that.
- Run only read-only git commands (status, diff, log, show). The calling agent reviews and commits.
- Do not add, remove or upgrade dependencies. Do not edit lockfiles, node_modules or other installed
  packages.
- Do not weaken checks to get a pass: no skipped, deleted or stubbed tests, no disabled lint or type
  rules, no `any` casts or ts-ignore comments to silence errors.
- Do not change behaviour to satisfy a type or lint rule.
- Keep explicit `unknown` return types.
- A `SAFETY:` comment must name the check that makes the cast safe. If none exists, keep the narrower type or leave the finding.
- Extract a shared helper instead of copying one.
- Never edit ticket files, MAP.md or SPEC.md. The orchestrator owns status.
- Do not move unfixed findings into new tickets. List them as unfixed.
- The calling agent runs the tests, lint and type-check after you. You may run them to check your
  work, but report the real result. If something blocks you, stop and say what it is instead of
  working around it.
- Report counts and results you measured, and say what you did not verify.
- Final report: each file you changed with a one-line summary, and anything you could not do.
