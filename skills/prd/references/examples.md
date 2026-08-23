# PRD Example — one worked milestone

> **Scope of this file.** This is a single **milestone** — the execution body of a PRD — **not** a whole
> PRD. It's deliberately just the milestone so loading it as a reference stays cheap. The full
> top-to-bottom anatomy — Title → Instructions for the implementer → Why this exists → Design notes →
> **Milestones** _(shown here)_ → Pre-PRD action items → Open questions → Out of scope — lives in the
> skill's "Anatomy of a PRD" section, and the fillable skeleton is
> [`../assets/templates/prd-template.md`](../assets/templates/prd-template.md).

A milestone written at the right altitude: concrete tasks that name paths / deps / patterns, a few
already worked (`- [x]` with an inline _italic note_ capturing the real decision made), one dropped task
left struck for the record, an inline **invariant** callout, a **Definition of done** written as
checkable verification, and a closing **Update** that hands off to the next session. This is where
implementation detail lives — an ADR records _why_; the PRD milestone records _what to build and how
you'll know it's done_. (The domain below — projecting Stripe payment webhooks into typed rows — is
illustrative; the point is the shape, not any real API.)

```markdown
## Milestone — Project `payment.*` webhooks into typed `paymentRecord` rows ✅

Turn raw Stripe `payment.*` webhook events (already persisted to `webhookEvent` by the ingestion
milestone) into typed, idempotent, **monotonic** `paymentRecord` rows — one per payment. No invoice
matching, no `orderId`, no bookkeeping sync; those land in the reconciliation and mark-paid milestones.
Sequenced first among the typed projections because every downstream consumer reads the typed row, never
the provider-shaped jsonb. (No ordinal in the heading — identity is the name; the ` ✅` is appended once
the Definition of done is met, and is the milestone's only status.)

> **The implementer's invariant:** `paymentRecord.providerPaymentId = webhookEvent.data.object.id`
> (the `pi_…` payment id) — the key the four `payment.*` events for one payment share — **not** the
> top-level envelope id (`evt_…`, which is unique per delivery). A wrong value here silently breaks
> exact-match in the reconciliation milestone. Verify it against a real captured payload before building.

- [x] Capture a real `payment.succeeded` envelope as the parser fixture and confirm the two load-bearing
      assumptions: the payment resource sits at `data.object` (its id ≠ the envelope id), and what unit
      `amount` uses — a 100× error here is catastrophic for exact-match. _Pulled a test-mode event from the
      provider dashboard; resource confirmed at `data.object`, and `amount` is already in **minor** units
      (cents) — store as-is, no ×100. Recorded both in the parser's doc-comment._
- [x] Add `parsePaymentEvent` in `packages/payments/src/stripe/parse-payment-event.ts`: a pure,
      unit-tested function over a Zod `looseObject`, returning a typed result or a typed `unhandled` /
      `error` variant. _Divergence from the first draft: the parser emits a provider-local
      `StripePaymentStatus`, not storage's domain `PaymentStatus` — the provider→domain map lives in the
      projection job, so `@acme/payments` never imports `@acme/storage`._
- [x] Add a DB-atomic monotonic upsert `upsertPaymentRecordFromProjection(...)` in
      `packages/storage/src/payments/payment-record.ts`: `INSERT … ON CONFLICT (provider_payment_id)
DO UPDATE … WHERE <new rank> >= <existing rank>`, so a late `pending` can't downgrade a `settled` row
      at the DB level. _Used `>=`, not `>` — re-projecting a corrected parser at the same status must
      overwrite a bad row; a dedicated test pins this._
- [ ] Add the projection job `apps/web/jobs/project-payment-event.ts` (id constant in
      `apps/web/jobs/constants.ts`), `concurrencyKey = providerPaymentId`. Terminal errors (unparseable /
      unknown shape / unsupported currency) → record `processingError` + mark processed, **don't throw**;
      transient (DB) errors → throw → let the job runner retry. Follow the existing `defineJob` pattern; run
      under the service-role DB context.
- [ ] Enqueue the projection from `apps/web/jobs/ingest-payment-event.ts` only when
      `inserted === true && eventType.startsWith('payment.')`. (Replays hit `ON CONFLICT` → no re-enqueue;
      recovery is the backfill, in the visibility milestone.)
- ~~Resolve `orderId` at projection time from the provider account id.~~ _Dropped — `orderId` comes from
  per-order checkout metadata or match time, neither of which exists yet, so payments land `orderId`-null._

**Affected paths**: `packages/payments/src/stripe/`, `packages/storage/src/payments/`, `apps/web/jobs/`.
**Patterns**: provider-specific shapes stay in the parser (the raw-log → projection split, ADR-0005);
never import `@acme/storage` from `@acme/payments`; wrap multi-statement writes in the shared
`withTransaction` helper, never the raw client.

**Definition of done:** firing a test-mode `payment.succeeded` projects to exactly **one** `paymentRecord`
with the correct `providerPaymentId` (= inner `data.object.id`), `amountMinor`, `status = settled`, and
`settledAt`; a subsequent `payment.reversed` flips it to `reversed` + sets `reversedAt`; a replayed or
out-of-order `pending` does not corrupt it (DB rank guard); `orderId` / `invoiceId` stay null with no
invoice-matching or bookkeeping side effects; `pnpm type-check` + `pnpm lint` + the payments / storage /
web tests are green.

**Update (2026-06-08).** Shipped — parser, storage upsert, and projection job landed; all automated checks
green and a test-mode firing confirmed the end-to-end path. Two gotchas closed: `reversedAt` reads the
**envelope** `created` timestamp (the resource carries none), and a reversed payload's absent `settled_at`
is COALESCE'd. Currency support widened mid-work from EUR-only to EUR **+ GBP** (UK customers imminent) —
added a `SUPPORTED_CURRENCIES` set + an exhaustive provider→domain `Record`, so the next currency is one
array entry + one map entry and the type checker flags a miss. The unmatched-payment **visibility +
projection backfill** work surfaced here but didn't fit; rather than hold this milestone open it moved to
its own "Unmatched-payment visibility" milestone — flagged to the author.
```

Notice what's **not** here: no "why a typed projection instead of letting product code read the raw
`webhookEvent` jsonb" rationale — that was a real decision, so it lives in an ADR (ADR-0005, durable, so
citing it by number is fine), linked from the PRD's Design notes, not restated in the milestone. And no
ordinal anywhere — sibling milestones are named ("the reconciliation milestone"), never numbered, so
inserting or reordering one is just moving a markdown block.
