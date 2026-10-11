# {{SCOPE}} map

An index, not a store: the whole implementation plan at low resolution, one line per ticket, enough
to judge relevance. Detail lives in the ticket, live status in its yaml, design in
[SPEC.md](./SPEC.md); never mirror them here. This file only takes new ticket entries, the
`Next up:` cursor, and a one-line outcome gist when a ticket closes.

## How this works

- One ticket = one file in `tickets/`, yaml frontmatter: `status`
  (ready|in-progress|blocked|parked|done), `blockedBy` (sibling ticket filenames and/or quoted
  one-line human prerequisites; omit = none).
- **Claim** a ticket by setting `status: in-progress` before any work. **Close** by setting
  `status: done` once its Definition of done is met and the final **Update (YYYY-MM-DD).** is
  appended, then add a one-line outcome gist to its entry under Tickets here. Max one ticket
  implemented per session.
- **Frontier** (ready, or blocked with every listed blocker done): run `./frontier.sh` in this
  directory. Its output is unordered; the `Next up:` cursor decides what's next.
- Long context lives in `assets/<name>.md` and spike write-ups in `spikes/<name>.md`, each linked
  from the spec or ticket it feeds.

**Next up:** _(best-effort pointer to the next ticket; verify its yaml status before trusting it)_

## Tickets
