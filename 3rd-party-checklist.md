# Third-Party Review Checklist (One-Page)

## Scope and review goal

- Path reviewed: Option A finalize hardening for EmDash Commerce webhooks.
- Primary objective: validate whether the implementation is correct enough for production rollout and identify the smallest safe improvements.
- Owner roles:
  - **RE** = Commerce plugin runtime engineer
  - **SRE** = platform/storage operator
  - **SEC** = security reviewer
  - **QA** = QA/automation owner

## Quick pass/fail criteria

1. No finalize side effects occur without valid webhook signature.
2. Duplicate webhook deliveries do not create duplicate inventory side effects.
3. Preflight validation failures do not apply partial stock mutations.
4. Deterministic payment-attempt selection is stable across retries.
5. Remaining concurrency risk is explicitly accepted with an owner and follow-up ticket.

## Issue-level checklist (severity + owner)

### 1) Webhook signature gate is bypassable by malformed request
- **Severity**: P1 (Integrity / Fraud)
- **What to verify**
  - `Stripe-Signature` is parsed and validated before finalize side effects.
  - Missing/invalid/malformed signatures return `WEBHOOK_SIGNATURE_INVALID`.
  - `settings:stripeWebhookSecret` must be required in deployment paths that receive webhooks.
- **Reviewer outcome**
  - `[ ]` Pass / `[ ]` Fail / `[ ]` N/A
- **Ownership**: **SEC** (validation), **RE** (fallback/edge-case handling)
- **Notes**
  - Current implementation: implemented in `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`.

### 2) Replay safety on duplicate webhook events
- **Severity**: P1 (Data integrity / Inventory)
- **What to verify**
  - Duplicate event IDs return replay/error semantics via existing receipt decision path.
  - Deterministic movement IDs prevent second write from creating additional ledger rows.
  - Duplicate deliveries do not produce negative stock totals.
- **Reviewer outcome**
  - `[ ]` Pass / `[ ]` Fail / `[ ]` N/A
- **Ownership**: **RE** (logic), **SRE** (runtime contention observations)

### 3) Partial mutation risk during preflight failures
- **Severity**: P1 (Inventory correctness)
- **What to verify**
  - Stock validation and normalization occur before stock/ledger writes.
  - Preflight failures return conflict/invalid-stock errors and preserve current stock.
  - Ledger has no row written when any validation fails.
- **Reviewer outcome**
  - `[ ]` Pass / `[ ]` Fail / `[ ]` N/A
- **Ownership**: **RE**

### 4) Nondeterministic payment-attempt selection
- **Severity**: P2 (State correctness)
- **What to verify**
  - Selection uses deterministic filter/sort (`orderId + providerId + status`, ordered by stable field).
  - Tests cover multiple pending attempts and earliest selection.
- **Reviewer outcome**
  - `[ ]` Pass / `[ ]` Fail / `[ ]` N/A
- **Ownership**: **RE**

### 5) Inventory movement index / replay model mismatch
- **Severity**: P2 (Idempotency)
- **What to verify**
  - Unique index definition for movement identity exists in `storage.ts`.
  - No migration gap for existing deployments where index is required for full guarantee.
- **Reviewer outcome**
  - `[ ]` Pass / `[ ]` Fail / `[ ]` N/A
- **Ownership**: **SRE** + **RE**

### 6) Residual concurrent-race window under perfect simultaneity
- **Severity**: P2 (Concurrency / Scaling)
- **What to verify**
  - Confirm if remaining race window is acceptable for current traffic profile.
  - Confirm follow-up plan if stronger guarantees are required (CAS/claim primitive).
- **Reviewer outcome**
  - `[ ]` Accept as-is / `[ ]` Requires follow-up / `[ ]` N/A
- **Ownership**: **RE** (design), **SRE** (capacity/risk)

## Final recommendation block

- **Recommended rollout readiness**: `[ ] Ready` / `[ ] Hold until fixes` / `[ ] Require follow-up`  
- **Owner**: `_____________________`
- **Review comments summary**:  
  - ______________________________________________________________________  
  - ______________________________________________________________________  
  - ______________________________________________________________________

