# Support Playbook: Customer paid but stock looks wrong

Use this quick checklist if a merchant or customer support agent reports, “The customer paid but the inventory is wrong.”

## What to check first

- Get the **Order ID** from support chat.
- Get the **payment event ID** from the webhook logs (if shown).
- Ask when the issue was first noticed (time and timezone).

## Quick checks in the system

1. Open the order.
   - If order is already `paid`, we usually only need to confirm consistency.
   - If order is not `paid`, it may be a failed retry and needs one finalize attempt.

2. Open webhook receipt status for that event.
   - `processed` = this event was already handled.
   - `pending` = event still needs one retry.
   - `error` or missing = do not retry blindly; escalate.

3. Open payment attempt rows for the order.
   - `succeeded` means finalize reached payment-attempt stage.
   - `pending` means we may have hit a partial-write failure.

4. Open inventory movement log for that order.
   - Ledger rows should exist if stock was already decremented.
   - Compare with current stock quantity.

## Decision: what to do

### Case A: Ledger and stock look correct, order already paid
- Do **not** change stock.
- Send confirmation back: this is a reconciliation pass with no manual change needed.

### Case B: Receipt is pending and order is not fully finalized
- Retry finalization **once**.
- Re-check:
  - order now says `paid`
  - payment attempt says `succeeded`
  - receipt now says `processed`

### Case C: Ledger says stock changed but stock still old, or data looks inconsistent
- Do **not** keep retrying.
- Escalate to engineering for manual investigation.

## When to escalate immediately

- Same order retries more than twice in 10 minutes.
- Repeated failures with:
  - `commerce.finalize.order_update_failed`
  - `commerce.finalize.attempt_update_failed`
- A paid order has no matching stock/ledger movement.

## What to write back to the merchant

“We confirmed the order/payment state and inventory records. We’re either good after one controlled retry, or we’ve escalated a data consistency issue to engineering.”
