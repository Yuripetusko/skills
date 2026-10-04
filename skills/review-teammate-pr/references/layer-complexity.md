# Layer: Code complexity

Comment label: `Code complexity`.

The question: will another developer, months from now, without the ticket, the PR description or
the author's session, understand why this change was made and why it took this approach? How much
effort does that take?

Read the code first as that developer would: the head files alone, without the brief. Note every
place you had to stop and guess. Then read the brief and check whether the guess was right. Each
place where the code alone didn't tell you the why is a candidate finding.

## What to check

- **A missing why.** Non-obvious decisions with no comment: magic numbers and timeouts, an
  ordering that matters, a workaround for an external system's quirk, a deliberately unhandled
  case, a surprising early return, a deviation from the pattern used everywhere else. Propose the
  exact comment text, one or two lines, about why, not what.
- **Too many comments.** Comments that narrate what the code already says, or that reference
  tickets, plans or phases a later reader won't have. Propose deleting them.
- **Concepts to hold.** Count the new types, flags, modes and layers a reader must keep in mind.
  Indirection that doesn't earn it (pass-through wrappers, single-use abstractions, configuration
  for one case) is a finding: propose the version with fewer moving parts. A refactor that moves
  complexity around without removing any isn't cleaner.
- **Readability.** Nested ternaries, long functions mixing orchestration with business logic,
  boolean parameters (`doThing(true, false)`), clever one-liners. Names that don't reveal what a
  thing holds or does: propose the honest name. If no honest name fits, the thing probably mixes
  two jobs; say that and propose the split.
- **The PR's shape.** More than ~1000 changed lines outside generated files, or a refactor mixed
  with a behavior change, makes the change hard to review and to bisect later. Propose a split as
  an unanchored finding.
- **Why only in the description.** A decision explained in the PR description but not in the
  code disappears from view after merge. Propose moving it into a comment at the spot.

## Effort estimate

End your `summary` with "Understanding effort: low / medium / high", and one sentence on what
drives it.

## Leave to other layers

Bugs (correctness), documented naming or style rules (quality), ticket fit (intent).
