# Commerce Refactor Option A — Execution Notes

This file summarizes what changed in this pass and what a reviewer should validate before production rollout.

## What was implemented

- Added deterministic finalization preflight in webhook orchestration.
- Added deterministic stock move ids with idempotent replay checks.
- Added deterministic pending-attempt selection for Stripe payment attempts.
- Added webhook signature verification guard using `Stripe-Signature` + secret from `settings:stripeWebhookSecret`.
- Added unit coverage:
  - `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`:
    - stable stock/ledger behavior on merge and failures
    - deterministic attempt selection
    - partial-failure prevention
  - `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`:
    - parse/verification helper behavior and stale/malformed checks
- Added `inventoryLedger` unique index over `(referenceType, referenceId, productId, variantId)` to support deterministic replay detection.

## What changed in runtime behavior

- Finalization now performs a strict read/validate pass before applying any writes.
- Finalization writes use deterministic ledger identifiers per `(orderId, productId, variantId)` and skip already-written lines.
- Webhook route now rejects calls that lack a valid webhook secret/signature before rate-limit + finalize processing.
- Checkout path behavior is unchanged in this implementation pass.

## Residual risk (outstanding)

- Without storage-level CAS/conditional writes, two in-flight deliveries of the same webhook event can still race under perfect simultaneity before the first inventory ledger write lands.
- This is bounded by:
  - event-specific webhook receipt row
  - deterministic payment attempt order
  - deterministic stock movement IDs (replay-safe after first write)
  - explicit residual-failure logging and `payment_conflict` status on preflight/write mismatches

## Suggested reviewer checklist

1. Confirm `settings:stripeWebhookSecret` is provisioned in all environments that accept webhooks.
2. Reproduce concurrent duplicate webhook replay and verify one success + one replay at route level.
3. Reproduce stale payload race conditions and inspect resulting receipt/order states.
4. Ensure storage provider supports `query` ordering by `createdAt` for `paymentAttempts`.
5. Decide whether a second-stage CAS/locking gate is required for your traffic profile.

