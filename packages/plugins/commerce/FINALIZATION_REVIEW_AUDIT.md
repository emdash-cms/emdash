# Finalization Receipt State and Replay Audit

Use this as the single audit artifact for recovery-path behavior in
`finalizePaymentFromWebhook()`.

## 1) Receipt-state exits after pending write

After `webhookReceipts.put(receiptId, { status: "pending", ... })`, every branch
must resolve to one of three outcomes:

- **`TERMINAL_ERROR`**: do not auto-retry on operator-triggered follow-up.
- **`RESUMABLE_PENDING`**: keep `pending` and retrying the same event should
  continue safely.
- **`COMPLETED`**: write `processed` and return success.

| Branch after pending write                                                      | Receipt status     | Why this outcome                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Re-read of order fails (`post_pending_lookup`)                                  | `error`            | The order row is gone; this is a terminal integrity signal for investigation.                                                          |
| Order no longer finalizable (`paymentPhase` not `payment_pending`/`authorized`) | `error`            | Concurrency or external mutation moved state; retrying blindly is unsafe.                                                              |
| Inventory preflight fails (version mismatch, insufficient stock, etc.)          | `pending`          | Side effects were intentionally not applied; retry can safely retry from scratch using same event context.                             |
| Order persistence fails (`orders.put` failure during finalization)              | `pending`          | Inventory may be applied, but payment-phase transition is incomplete; retry is expected.                                               |
| Payment attempt persistence fails (`paymentAttempts.put` failure)               | `pending`          | Order may be paid, but attempt state is incomplete; retry is expected.                                                                 |
| Finalization writes succeed, but `webhookReceipts.put(processed)` fails         | `pending` (throws) | Caller receives a transport error; a retried call continues from the same idempotent state and should now complete receipt processing. |
| Full success path                                                               | `processed`        | Terminal success; subsequent replay returns `replay` semantics where appropriate.                                                      |

## 1b) Log events for recovery tooling

Preferred operational events:

- `commerce.finalize.receipt_pending`
- `commerce.finalize.order_not_found`
- `commerce.finalize.order_not_finalizable`
- `commerce.finalize.inventory_reconcile`
- `commerce.finalize.inventory_applied`
- `commerce.finalize.inventory_failed`
- `commerce.finalize.order_settlement_attempt`
- `commerce.finalize.payment_attempt_update_attempt`
- `commerce.finalize.receipt_processed`
- `commerce.finalize.completed`

## 2) Duplicate delivery & partial-failure replay matrix

| Scenario                                                                              | Expected outcome                                                             | Why it is safe today                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Duplicate webhook event with same `(providerId, externalEventId)` in a shared runtime | Idempotent or replay-like behavior (status transitions + deterministic IDs). | Existing receipt key (`webhookReceiptDocId`) is stable; ledger/order writes are deterministic.                   |
| Same event replay while previous attempt is still `pending`                           | Resume from `pending` state; side effects remain bounded.                    | Decision/receipt/query logic is deterministic and keyed by the same event id.                                    |
| Partial failure after some side effects (inventory/order/attempt)                     | Receipt stays `pending` unless missing/non-finalizable order case.           | In-progress state is preserved and documented for safe retry.                                                    |
| Perfectly concurrent cross-worker delivery                                            | Residual risk remains bounded.                                               | Claim ownership now uses lease metadata plus ownership-version checks; safe revalidation points can short-circuit writes before side effects, but platform-specific timing around concurrent updates is still a residual watchpoint. |

## 3) Operational references

- Primary contract for this path: `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- Receipt state query helper: `queryFinalizationStatus`
- Current proof points:
  - `src/orchestration/finalize-payment.test.ts` (pending branches, retry, and duplicate delivery)
  - `src/services/commerce-extension-seams.test.ts` (status query contract)
