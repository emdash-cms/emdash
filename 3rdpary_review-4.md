# Third-Party Evaluation Brief — Commerce Finalize Hardening (Option A execution)

> Historical review packet (Option A). Canonical current entrypoint is:
>
> - `@THIRD_PARTY_REVIEW_PACKAGE.md`
> - `external_review.md`
> - `SHARE_WITH_REVIEWER.md`

## Executive summary

This review package covers the Option A hardening pass for the EmDash Commerce plugin, focused on webhook-driven payment finalize integrity.  
The current implementation improves reliability of the `stripe` webhook finalize path by making side effects deterministic, adding signature validation, and making inventory mutation behavior safer under duplicate/malformed flows.

The guiding constraint is still your original brief:

- keep changes narrow
- avoid over-engineering
- prioritize correctness over speculative features
- remain review-friendly for external audit before moving to Stage 2

## Ecosystem context (what this code lives in)

- `packages/plugins/commerce` is a plugin package in a pnpm monorepo.
- Runtime writes are performed through EmDash plugin storage abstractions (`ctx.storage` + `StorageCollection`).
- Public plugin routes are defined in `packages/plugins/commerce/src/index.ts`.
- Route handlers are currently thin wrappers that call orchestration modules and throw API errors through existing error contracts.
- Checkout and finalize flows intentionally stay isolated from storefront/catalog concerns and do not couple recommendation/agent read paths.

## Why this pass was needed

Three categories of risk were addressed:

1. **Security/inbound trust**
   - Webhook traffic was entering finalize logic without cryptographic proof, creating an integrity risk.
2. **Correctness under duplicates and retries**
   - `webhookReceipts` and deterministic identifiers reduce duplicate side effects but pre-existing write patterns could still expose partial mutation windows.
3. **Determinism/state consistency**
   - Payment attempt updates could vary based on storage ordering, and partial stock/ledger writes were possible during failures.

## Files changed in this implementation pass

### Core logic

- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
  - Added deterministic inventory preflight + normalization path:
    - validate required stock rows and line-item consistency before writes.
    - convert intended stock adjustments into deterministic movement plans.
  - Added deterministic ledger IDs via `inventoryLedgerEntryId(...)`.
  - Added idempotent replay-safe mutation path by skipping already-written movement IDs.
  - Kept payment conflict/error mapping deterministic and explicit.

- `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
  - Added webhook signature verification:
    - parses `Stripe-Signature`
    - validates timestamp tolerance
    - validates HMAC (`whsec` style hex signature) using settings secret
  - rejects invalid/missing signature before finalize execution.
  - exposes helper exports for focused unit tests.

### Guardrails / schema tightening

- `packages/plugins/commerce/src/storage.ts`
  - Added unique index for deterministic inventory movement replay safety:
    - `inventoryLedger`: `["referenceType","referenceId","productId","variantId"]`

- `packages/plugins/commerce/src/handlers/checkout.ts`
  - Added stronger input checks to reject malformed line items (`quantity`, `inventoryVersion`, `unitPriceMinor`) before order creation.

### Tests added/updated

- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
  - Added scenarios:
    - earliest-pending provider attempt is chosen deterministically
    - duplicate SKU merge still yields one ledger movement
    - preflight failure leaves stock/ledger unchanged (partial-write prevention)
  - In-memory storage mock now supports `orderBy` for deterministic pending-attempt behavior.

- `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts` _(new)_
  - Added signature helper unit coverage:
    - parse format
    - valid v1 signature
    - bad secret rejection
    - missing timestamp rejection
    - stale timestamp rejection

## Known residual risk (explicit)

- Storage currently lacks native CAS/conditional writes or transactional locking in the orchestration contract used here.
- In a perfect simultaneous duplicate webhook delivery race, one delivery can still attempt overlapping writes before first-commit visibility.
- The current design is replay-bounded and recoverable through receipt ledgering and deterministic IDs, but a true CAS/receipt-lock step remains the next hardening milestone if your volume/profile requires stronger isolation.

## Third-party evaluator checklist

### What to validate first

1. Confirm environment configuration includes `settings:stripeWebhookSecret` in all production and staging runtime paths used by webhook ingestion.
2. Verify raw request body consumption remains compatible with EmDash route pipeline in production workers.
3. Confirm storage guarantees around `query` sorting and unique index enforcement on `inventoryLedger`.

### What to validate during review

1. Security
   - invalid signatures cannot reach finalize side effects
   - malformed / missing signatures fail safely
2. Determinism
   - one deterministic attempt is selected across multiple pending attempts
   - duplicate SKU merge produces one stock movement row
3. Integrity
   - preflight failures produce no stock mutation
   - inventory version mismatch and insufficient stock map to stable API errors
4. Idempotency/replay behavior
   - duplicate webhook deliveries of same event do not create duplicate stock side effects

### Suggested production rollout checks

1. Deploy to staging with production-like concurrency.
2. Send duplicate/simultaneous webhook deliveries and verify:
   - one success, one replay or controlled terminal conflict path
   - no negative stock from partial writes
3. Monitor for `commerce.finalize.inventory_failed` and `commerce.finalize.token_rejected` logs.

### Clear review path for a 3rd-party evaluator

1. **Start with context**
   - `3rdpary_review-4.md` (this document)
   - `COMMERCE_REVIEW_OPTION_A_PLAN.md`
   - `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md`
2. **Inspect runtime contracts**
   - `packages/plugins/commerce/src/index.ts`
   - `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
   - `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
3. **Inspect constraints and storage model**
   - `packages/plugins/commerce/src/storage.ts`
4. **Validate test coverage**
   - `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
   - `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`
5. **Validate behavior against this matrix**
   - `WEBHOOK_SIGNATURE_INVALID` on bad/missing signatures
   - duplicate events produce replay or controlled terminal conflict semantics
   - insufficient stock/version mismatch remains non-partial
   - deterministic payment attempt selection
   - no duplicate movement rows for duplicate SKUs
6. **Finalize decision**
   - Confirm residual concurrent-race risk is acceptable for current scale
   - Decide whether a stronger CAS/lock path should be phase-2 scope

## Artifacts this review package is optimized for

- Implementation plan and status:
  - `COMMERCE_REVIEW_OPTION_A_PLAN.md`
  - `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md`
  - `3rdpary_review-4.md` (this document)
- Core implementation/test bundle:
  - `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
  - `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
  - `packages/plugins/commerce/src/storage.ts`
  - `packages/plugins/commerce/src/handlers/checkout.ts`
  - `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
  - `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`

## Decision support for 3rd-party suggestions

The current path intentionally avoids broad redesigns (no middleware/framework migration, no new plugin boundaries, no new schema surface area).  
If reviewer confirms current delivery profile needs stronger concurrency guarantees, the recommended follow-up should be:

1. introduce a storage-level claim primitive (or explicit lock emulation) for webhook receipts, then
2. fold claim + mutation into one atomic boundary where backend storage allows it,
3. keep current deterministic IDs as a second line of defense for replay safety.
