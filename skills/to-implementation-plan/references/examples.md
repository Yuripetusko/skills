# Ticket example: one worked ticket

A session-sized ticket mid-work: yaml status on top, tasks that name paths and patterns, two
already worked with _italic notes_ recording the real decision made, a verification-style
Definition of done, and a closing Update handoff. (The domain, projecting Stripe payment webhooks
into typed rows, is illustrative; the point is the shape.)

```markdown
---
status: in-progress
---

# Ticket: Project `payment.*` webhooks into typed `paymentRecord` rows

One session-sized deliverable of [payment-setup-mvp](../SPEC.md). The spec is the design source
of truth; surface gaps there first, don't re-litigate here.

## Why this exists

Raw Stripe `payment.*` webhook events are already persisted to `webhookEvent` by the ingestion
ticket, but every downstream consumer still reads provider-shaped jsonb. This ticket turns them
into typed, idempotent, monotonic `paymentRecord` rows, one per payment, so consumers never touch
the raw payload. Sequenced first among the typed projections; invoice matching and bookkeeping
sync are sibling tickets.

## Design notes

> **The implementer's invariant:** `paymentRecord.providerPaymentId = webhookEvent.data.object.id`
> (the `pi_…` payment id), the key the four `payment.*` events for one payment share, **not** the
> top-level envelope id (`evt_…`, unique per delivery). A wrong value here silently breaks
> exact-match in the [reconciliation ticket](./payment-reconciliation-ticket.md). Verify against a
> real captured payload before building.

Why a typed projection at all (instead of product code reading the raw jsonb) was a real decision.
It lives in ADR-0005, linked from the spec, not restated here.

## Tasks

- [x] Capture a real `payment.succeeded` envelope as the parser fixture and confirm the resource
      location and `amount` unit; a 100× error here breaks exact-match. _Resource confirmed at
      `data.object`; `amount` is already in minor units (cents). Store as-is, no ×100._
- [x] Add `parsePaymentEvent` in `packages/payments/src/stripe/parse-payment-event.ts`: pure,
      unit-tested, Zod `looseObject`, returning a typed result or an `unhandled` / `error` variant.
      _Diverged from the draft: the parser emits a provider-local `StripePaymentStatus`; the
      provider→domain map lives in the projection job, so `@acme/payments` never imports
      `@acme/storage`._
- [ ] Add a DB-atomic monotonic upsert `upsertPaymentRecordFromProjection` in
      `packages/storage/src/payments/payment-record.ts`: insert-on-conflict guarded by
      `WHERE <new rank> >= <existing rank>`, so a late `pending` can't downgrade a `settled` row.
- [ ] Add the projection job `apps/web/jobs/project-payment-event.ts`,
      `concurrencyKey = providerPaymentId`. Terminal errors: record `processingError` and mark
      processed, don't throw. Transient (DB) errors: throw and let the runner retry. Follow the
      existing `defineJob` pattern.
- [ ] Enqueue the projection from `apps/web/jobs/ingest-payment-event.ts` only when
      `inserted === true && eventType.startsWith('payment.')`.

## Definition of done

Firing a test-mode `payment.succeeded` projects to exactly one `paymentRecord` with the correct
`providerPaymentId` (= inner `data.object.id`), `amountMinor`, `status = settled`, and `settledAt`;
a replayed or out-of-order `pending` does not corrupt it; `orderId` / `invoiceId` stay null with no
invoice-matching side effects; `pnpm type-check`, `pnpm lint` and the payments / storage / web
tests are green.

## Out of scope

- Invoice matching, `orderId` resolution, bookkeeping sync: the
  [reconciliation](./payment-reconciliation-ticket.md) and mark-paid sibling tickets.

**Update (2026-06-08).** Parser and fixture landed; storage upsert next. `reversedAt` must read
the **envelope** `created` timestamp (the resource carries none); noted in the upsert task. The
unmatched-payment visibility work surfaced here but didn't fit; moved to a new
`unmatched-payment-visibility-ticket.md` (`status: blocked`, blockedBy this ticket) and flagged to
the author.
```

Notice what's not here: no milestones (a bigger scope means more sibling tickets, wired with
`blockedBy`), no rationale for the typed projection (that's ADR-0005, linked), and no ordinals;
siblings are referenced by path.
