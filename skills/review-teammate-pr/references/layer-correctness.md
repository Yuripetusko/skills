# Layer: Code correctness

Comment label: `Code correctness`.

The question: given what the author meant to build, does the code do it without breaking anything?
And if a clearly better approach exists, what is it?

Take the author's intent as given: the PR description, commits and code comments say what the
code is meant to do. Whether that intent is the right behavior for the business, or matches the
ticket, belongs to the intent layer. Your ground is failure paths, regressions, data integrity
and security. Where the code contradicts the author's own stated intent, that's yours too.

## What to check

- **The PR's claims.** For each behavioral claim in the brief ("fixes X when Y", "no behavior
  change for Z"), trace the code and confirm or refute it. A refuted claim is a finding; a
  confirmed one may be worth praise.
- **Logic.** Wrong or inverted conditions, off-by-one, null/undefined/empty handling, boundary
  values, date and timezone handling, units, rounding, ordering assumptions, enum cases not
  handled.
- **Regressions.** For every changed signature, return shape, default value, enum, query filter or
  exported behavior, find the callers at head (`git grep`) and check each one still holds,
  including callers the PR didn't touch. For removed code, check nothing still depends on it.
  Compare against the base version (`git show <merge-base>:<path>`) when the old behavior matters.
- **Error paths.** Swallowed errors, writes that can half-succeed outside a transaction, retries
  that repeat side effects (emails, payments, uploads), missing `await`, races between concurrent
  runs, re-runs that aren't idempotent.
- **Data.** Migrations against existing rows (nullability, defaults, backfill), what happens to
  records created before the change, cache invalidation.
- **Access and security.** New queries or endpoints: who can call them, and are they scoped to the
  right tenant or user? Untrusted input reaching queries, HTML or logs; secrets in logs.
- **Tests.** Do they exercise the changed behavior, including its failure or edge path? Would they
  fail if the new condition were inverted or removed? Name the specific missing case ("no test
  where the approved update omits `endDate`") rather than "add more tests". Check CI with
  `gh pr checks <n> --repo <repo>` and report failing checks related to the change.

## A better approach

Propose one only when it's concrete and clearly simpler or safer: an existing helper already does
this (show where, via `git grep`), or a different structure removes a branch, a flag or a failure
mode. Sketch it in a few lines of code. A rewrite that's merely how you'd have done it is not a
finding.

## Leave to other layers

Conventions and style (quality), whether the intended behavior is the right one for the ticket
and the business (intent), readability and missing comments (complexity). If you spot one in
passing that's serious, include it anyway; the orchestrator deduplicates.
