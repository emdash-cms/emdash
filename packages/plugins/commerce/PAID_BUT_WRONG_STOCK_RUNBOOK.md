# Runbook: Paid order but inventory appears wrong

Use this if a merchant reports: **“customer is marked paid, but stock is wrong.”**

## 1) What we want to confirm first

- Customer order ID
- Payment external event ID (from the payment provider/webhook)
- Approximate incident time (UTC)
- Logs for this order/event in the last 24h:
  - `commerce.finalize.order_update_failed`
  - `commerce.finalize.attempt_update_failed`
  - `commerce.finalize.inventory_failed`
  - `commerce.finalize.completed`

## 2) Check order and webhook state

- Open the order:
  - If `paymentPhase = paid`, treat as “possibly finalized.”
  - If `paymentPhase` is still `payment_pending`/`authorized`, a finalization retry may still be needed.
- Open webhook receipt row for the event:
  - `processed` = finalize already completed for this event.
  - `pending` = retry path may be needed.
  - `error`/missing = inspect logs before retrying.
- Open payment attempt rows for this order/provider:
  - `succeeded` means payment attempt did finalize.
  - `pending` means finalization likely interrupted.

## 3) Check stock/ledger consistency

- Open inventory ledger rows with:
  - `referenceType = "order"`
  - `referenceId = <orderId>`
- Open current stock rows for SKUs in the order.

## 4) Decision tree (do only one path)

### A. Ledger has order entry **and** stock looks decremented correctly
- If order is not yet `paid` (or attempt still `pending`) and receipt is `pending`:
  - Retry finalize once.
  - Re-check that order is `paid`, attempt is `succeeded`, receipt is `processed`.
- If order is already `paid` and receipt is `processed`:
  - Do **not** force state changes.
  - Report as successful reconciliation.

### B. Ledger exists but stock did not move
- Do **not** repeatedly retry finalize.
- Escalate to engineering immediately; this indicates storage inconsistency.

### C. Ledger missing and stock not moved, but order is `paid`
- Do **not** force stock edits in product admin on your own.
- Escalate immediately for manual reconciliation.

## 5) Safe retry notes

Retries should be run only when evidence says the order was likely in partial-write state.

- Run a single retry.
- Re-check after it completes:
  - order becomes `paid`
- If it fails again, stop and escalate.

## 6) Escalation checklist

- Create/attach a ticket with:
  - orderId, payment event id, timestamps
  - order state before/after
  - receipt state (`processed/pending/error`)
  - stock and ledger IDs involved
  - whether retry was attempted and result code/message
- Assign to: on-call engineer + merchant support lead.

## 7) Alerting recommendation

Enable alerting if the same order/retry pattern happens repeatedly:
- 2+ finalize retries in 10 minutes for the same order, or
- Same event ID repeatedly ending in `order_update_failed` / `attempt_update_failed`.

## 8) Final communication to merchant

Use this template:

> We verified partial finalization behavior for this order.  
> Current state is [paid | not paid], receipt state is [state], stock/ledger are [in-sync | out-of-sync].  
> Action taken: [retry / escalated].  
> If unresolved, next step is manual ledger-stock reconciliation with engineering.
