# Minimal required regression checks for commerce plugin tickets

Use this as a minimal acceptance gate for any follow-on ticket.

## 0) Finalization diagnostics (queryFinalizationState)

- Assert rate-limit rejection (`rate_limited`) when `consumeKvRateLimit` denies.
- Assert cache or in-flight coalescing: repeated or concurrent identical keys do not
  multiply `orders.get` / storage reads beyond one pass per cache window.

## 1) Concurrency / replay regression

- Add/extend a test that replays the same webhook event from two callers with shared
  `providerId` + `externalEventId` and asserts:
  - Exactly one settlement side-effect is recorded (`order` reaches paid once).
  - `queryFinalizationState` transitions to `replay_processed` or `replay_duplicate`.
  - No uncontrolled exceptions are emitted for second-flight calls.
- Ensure logs include `commerce.finalize.inventory_reconcile`, `payment_attempt_update_attempt`,
  and terminal `commerce.finalize.completed` / replay signal.

## 2) Inventory preflight regression

- Add/extend a test where cart inventory is stale/out-of-stock and checkout is rejected
  with one of:
  - `PRODUCT_UNAVAILABLE`
  - `INSUFFICIENT_STOCK`
- Verify preflight happens before order creation and idempotency recording.
- Verify stock/version snapshots (`inventoryVersion`) are checked by finalize before decrement.

## 3) Idempotency edge regression

- Add/extend a test for each new mutation path that verifies:
  - Same logical idempotency key replays return stable response when request payload hash
    is unchanged.
  - Payload hash drift (header/body mismatch or changed request body) is rejected.
  - Duplicate storage writes in an error/retry path do not create duplicate ledger rows.
- Ensure replay states still preserve all required idempotency metadata (`route`, `attemptCount`,
  `result`).
