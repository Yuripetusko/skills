---
status: ready # ready | in-progress | blocked | parked | done
# blockedBy: sibling ticket filenames and/or quoted one-line human prerequisites. Only when blocked/parked
#   - other-feature-ticket.md
#   - "Yuri creates the Stripe test key"
---

# Ticket: {{TITLE}}

One session-sized deliverable of [{{SCOPE}}](../SPEC.md). The spec is the design source of truth;
surface gaps there first, don't re-litigate here. Working rules:

- Tick `[x]` the moment a task is done; flip the yaml `status` at the same cadence.
- Don't add scope that isn't listed.
- Move leftovers to a sibling ticket instead of holding this one open.
- Append an **Update (YYYY-MM-DD).** paragraph at the end when you stop working.

## Why this exists

{1–2 paragraphs: the problem, and why the scope is shaped this way.}

## Design notes

{Named sub-decisions and invariants: "do X not Y, and the failure mode if you don't". `###` per
topic. Link an ADR for anything that was a real decision rather than a detail.}

## Tasks

- [ ] {task: name the affected paths, deps to add/remove, patterns to follow/avoid}
- [ ] {task}

## Definition of done

{Checkable verification: commands to run, greps that come back empty, observable behaviour. Not
"it works".}

## Prerequisites

{Human/manual prerequisites, one sentence each; delete the section if none. The gate is
`status: blocked` above.}

- [ ] {prerequisite}

## Out of scope

- {explicitly out, so the implementer doesn't build more than asked}
