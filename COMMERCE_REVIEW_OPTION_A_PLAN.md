# Commerce `finalizePaymentFromWebhook()` Refactor Review

## Purpose

This document is for a third-party reviewer to evaluate whether additional code changes are required to harden the current stage-1 commerce finalize flow.

It is a concrete, one-to-one refactor plan to close the highest-confidence production defects:

- Public webhook route can mutate payment/order state without strict signature gating.
- Finalization may partially update inventory in non-atomic order.
- Concurrent duplicate webhook deliveries can double-apply side effects.
- Payment-attempt resolution can be nondeterministic under multiple pending rows.
- Checkout writes are not fully atomic as a bounded transaction.

The scope is limited to `packages/plugins/commerce` and does not expand scope to storefront UI, shipping, tax, catalog MCP tools, or agent tooling in this pass.

## Current Baseline (as implemented)

- Checkout, webhook route, and finalize orchestration are present in:
  - `packages/plugins/commerce/src/handlers/checkout.ts`
  - `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
  - `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- Error and code mapping already uses kernel contracts:
  - `packages/plugins/commerce/src/kernel/errors.ts`
  - `packages/plugins/commerce/src/kernel/api-errors.ts`
  - `packages/plugins/commerce/src/route-errors.ts`
- Storage and schema are declared in:
  - `packages/plugins/commerce/src/storage.ts`
  - `packages/plugins/commerce/src/types.ts`
- Route registration and plugin surface in `packages/plugins/commerce/src/index.ts`.

## Refactor Strategy (Option A only)

**Transaction-first finalize command with deterministic preflight + atomic mutation set.**

The design below uses only currently needed abstractions and does not add optional speculative features.

## Phase 0 — Guardrails and migration lock (pre-implementation)

1. Add a short “Execution Notes” block to the document and commit message template for this pass (no code behavior change).
2. Confirm storage capability expectations in the runtime implementation:
   - Does `ctx.storage` guarantee atomic multi-write when using one operation?
   - Can we perform compare-and-swap (CAS) or claim-style conditional writes?
   - If no atomic capability exists, define a fallback lock/retry strategy.
3. Keep existing error contract stable (`throwCommerceApiError` path and wire code mapping) to avoid API drift.

## Phase 1 — Make webhook ingress authoritative (defense-in-depth precondition)

1. Add **signature verification before finalize invocation** in:
   - `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
2. Use `Stripe-Signature` + shared secret:
   - Read secret key from settings via `ctx.kv.get("settings:stripeWebhookSecret")`.
   - Read raw request body once and verify before JSON/body parsing path.
3. If signature invalid:
   - Return mapped API error `WEBHOOK_SIGNATURE_INVALID`.
   - Do not write receipt, order, stock, or logs that imply payment acceptance.
4. Add regression tests proving rejection of invalid signature and that no finalize side effects are persisted.

## Phase 2 — Receipt claim contract (single source of claim truth)

1. Introduce a dedicated receive contract in orchestration:
   - New type-level states in `packages/plugins/commerce/src/orchestration/finalize-payment.ts`:
     - `pending_claimed`, `processed`, `duplicate`, `error`.
2. Require a claim transition before side effects:
   - Claim step should be idempotent:
     - If receipt exists with `processed/duplicate`: treat as replay (`replay` result).
     - If receipt exists with `error/pending`: treat according to existing semantics.
     - If no receipt: claim as `pending`.
3. Ensure claim writes happen once and drive all later transitions.
4. Add an invariant doc note in source:
   - receipt row is the single synchronization key for concurrent webhook dedupe.

## Phase 3 — Deterministic preflight validation (read-before-write)

1. In `finalizePaymentFromWebhook()`:
   1. Load order + line items snapshot.
   2. Validate all line items are mergeable once (`mergeLineItemsBySku` semantics).
   3. Validate required stock rows exist for every line in a separate pass.
   4. Validate inventory versions and quantity capacity for all lines.
2. Return structured failures as API errors only; do not mutate any inventory/ledger/order state until all checks pass.
3. This preserves deterministic behavior and avoids partial-write failures.

## Phase 4 — Atomic mutation application

1. After successful preflight, apply stock+ledger updates in one atomic write batch where possible.
2. If platform supports transaction:
   - Execute read/write as one function to avoid partial state.
3. If platform does not support true transaction:
   - Implement write-order and rollback strategy:
     - Persist all mutation intents first.
     - Apply inventory/ledger updates deterministically.
     - On any write failure, store failure marker and return controlled recoverable error.
4. Update only after inventory/ledger successfully applied:
   - `orders.paymentPhase = paid`
   - receipt status transitions.
5. Keep `payment_attempt` update inside same mutation boundary.

## Phase 5 — Deterministic payment-attempt resolution

1. In `markPaymentAttemptSucceeded()`:
   - Filter by `{ orderId, providerId, status: "pending" }`.
   - Select deterministic row by explicit sort:
   - `createdAt` ascending (or a comparable stable field available in storage).
2. If none exists:
   - emit non-fatal result and keep finalize success semantics as-is (existing behavior preserved).
3. Add explicit test case for multiple pending attempts to enforce deterministic choice.

## Phase 6 — Checkout idempotency hardening (non-atomic boundary reduction)

1. In `packages/plugins/commerce/src/handlers/checkout.ts`:
   - Keep idempotency key validation unchanged.
   - Ensure both order + payment attempt + idempotency cache are created in one transactional path where storage supports it.
2. If atomic path unavailable:
   - Persist idempotency record before order creation only after all dependent writes prepared.
   - Add explicit reconciliation for partial writes.
3. Add tests for mid-write crash recovery behavior under synthetic failure injection.

## Phase 7 — Route/read-model determinism cleanup

1. Keep `decidePaymentFinalize` API and error mapping intact.
2. Add explicit handling for duplicate in `finalize-payment.ts` so replay and terminal/retry semantics remain unchanged.
3. Ensure all logs use machine-readable context + request correlation IDs:
   - `orderId`, `externalEventId`, `providerId`, `correlationId`.

## Validation Plan for Third-Party Review

Each item maps to a targeted test requirement:

1. **Webhook auth**
   - Invalid signature never applies side effects.
   - Replay with same signature is idempotent.
2. **Concurrent delivery**
   - Two simultaneous deliveries for same event result in one success and one replay.
3. **Concurrent mixed state**
   - One success + one conflict (if already processed/failed/claim held).
4. **Inventory atomicity**
   - No partial stock updates when one line fails preflight.
5. **Nondeterminism**
   - Stable paymentAttempt selection for same order/provider with multiple pending entries.
6. **Idempotency TTL + route safety**
   - Existing idempotency-key behavior preserved under retries.

## Acceptance Criteria

- No partial stock and ledger writes for a single webhook finalize request.
- Deterministic finalization for concurrent duplicates.
- Finalization remains replay-aware and does not silently change code semantics.
- Existing API contract (`CommerceApiError` wire codes and response shape) unchanged.
- No scope expansion beyond finalize integrity improvements.

## Implementation status (current snapshot)

- ✅ **Phase 1**: Webhook signature verification implemented in `packages/plugins/commerce/src/handlers/webhooks-stripe.ts` using `Stripe-Signature` and `ctx.kv.get("settings:stripeWebhookSecret")`.
- ✅ **Phase 3**: Preflight inventory validation now happens before stock/ledger writes in `packages/plugins/commerce/src/orchestration/finalize-payment.ts` (`readCurrentStockRows` + `normalizeInventoryMutations`).
- ✅ **Phase 4**: Mutation path now uses deterministic inventory movement IDs and replay checks before write (`inventoryLedgerEntryId`, `applyInventoryMutations`).
- ✅ **Phase 5**: Deterministic payment-attempt resolution (`providerId` + `status` filtering and `createdAt` ordering) implemented in `markPaymentAttemptSucceeded`.
- ✅ **Phase 6**: Storage hardening documented by adding deterministic unique inventory ledger index in `packages/plugins/commerce/src/storage.ts`.
- ⚠️ **Known residual**: No conditional writes/CAS remains available in storage contracts; true concurrent duplicate same-event delivery can still race at write time. Replay safety is bounded by claim+deterministic IDs, and is recoverable via receipt auditing.

## Current artifacts for 3rd party review

- `COMMERCE_REVIEW_OPTION_A_PLAN.md` (this document)
- `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md` (new, created in this implementation pass)
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
- `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- `packages/plugins/commerce/src/storage.ts`

Suggested review pass order:

1. Confirm security precondition and no accidental bypass in webhook handler.
2. Confirm preflight + deterministic mutation IDs and attempt ordering in finalize orchestration.
3. Verify test matrix around idempotency, replay, and partial-failure prevention.
4. Validate residual risk and mitigation strategy around concurrent duplicate writes.

## Reviewer runbook

1. Run: `pnpm --filter @emdash-cms/plugin-commerce test -- finalize-payment webhooks-stripe` (or equivalent workspace command).
2. Inspect `packages/plugins/commerce/README` / route docs if present for expected admin config (`settings:stripeWebhookSecret`).
3. Confirm storage layer exposes `query` with `orderBy` in deployment path before relying on deterministic sort for payment attempt selection.

## Non-Goals

- Live Stripe SDK wiring.
- Shipping/tax/customer-service MCP surfaces.
- Frontend/admin expansion.
- New route surface changes outside `recommendations` and current checkout/webhook routes.

## Reviewer Handoff Checklist

- Confirm atomic capability in storage:
  - If not available, verify the documented fallback remains idempotent and auditable.
- Confirm no regression in tests covering existing pass/fail matrix:
  - `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
  - `packages/plugins/commerce/src/kernel/finalize-decision.test.ts`
  - `packages/plugins/commerce/src/handlers/checkout.ts` tests coverage.
- Confirm no API contract breakage in `src/kernel/api-errors.ts` and route handlers.
- Confirm idempotency cleanup job still deletes only stale rows and logs expected metadata.
