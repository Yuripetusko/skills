# Layer: Semantic intent

Comment label: `Semantic Intent`.

The question: why was this code written, and does the implementation fulfill that business
contract? Code can be correct, clean and still do the wrong thing.

Assume the code works as written; the correctness layer hunts for bugs, failure paths and
security holes. Your ground is whether the behavior it produces is the right one: against the
ticket or spec, for the people and data it affects, and over time (existing records, later
status changes, other flows that now see different data). Read the product docs the brief lists
alongside the code, since that is where business rules this change can collide with live.

## The contract

Take it from the brief's Contract section: the ticket's acceptance criteria, the spec or plan
section. When there's none, the brief infers the contract from the PR description and commits:
review against that, and open your `summary` with "No ticket or spec found; reviewed against the
PR description." Read the original source yourself when the brief's quote is too thin to judge a
requirement.

## What to check

- **Each requirement.** Implemented, partial, missing, or implemented differently from what it
  says. Quote the requirement in the finding. List the verdict per requirement in your `summary`.
- **The business rule behind the text.** Does the code honor what the requirement means for the
  business, not just its literal words? Typical gaps:
  - who can see or do this (roles, tenants, ownership)
  - which records it applies to: new ones only, or existing ones too, and are those backfilled?
  - money, dates, time zones, locales: whose time zone, which currency, which language
  - what the user sees in edge states: empty, failed, partially done, retried
  - what happens on the second run, the undo, the concurrent edit
- **Claims vs contract.** The PR description promises an outcome ("leads are only uploaded once
  qualified") that the ticket words differently, or that holds only for part of the cases the
  ticket covers. Whether the code matches the description is the correctness layer's job; whether
  the description matches the contract is yours.
- **Scope creep.** Behavior nobody asked for. Not every extra is bad: flag it when it's
  user-visible, changes data, or carries risk without a stated reason.
- **Domain language.** The code names the concepts the way the ticket, spec and existing model
  do. A new synonym for an existing concept, or one name used for two concepts, misleads the next
  reader.

## Anchoring

Pin each finding to the line that implements, or should implement, the requirement. A requirement
with no natural line (nothing was built for it) is `anchored: false`, with the most relevant file
as `path`.

## Leave to other layers

Bugs, failure paths and security (correctness), conventions (quality), readability (complexity).
A bug that also breaks a requirement is still worth reporting from the contract side: say which
requirement it breaks.
