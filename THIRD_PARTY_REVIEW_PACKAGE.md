# Third-Party Review Package (Comprehensive, One File)

## Purpose

This is the single document to share with a 3rd-party developer for evaluating the Commerce finalize hardening work (Option A execution).

If only one document is shared, share this file first, and then attach `latest-code-4.zip`.

## What this package covers

It covers the full integrity hardening work in `packages/plugins/commerce`, with emphasis on:

- Webhook signature enforcement
- Finalize idempotency and replay behavior
- Inventory mutation correctness (no partial writes)
- Deterministic payment-attempt selection
- Review evidence and residual risk

---

## Must-read first (in this order)

1. `README_REVIEW.md`
2. `THIRD_PARTY_REVIEW_PACKAGE.md` (this file)
3. `3rd-party-checklist.md`
4. `3rdpary_review-4.md`
5. `COMMERCE_REVIEW_OPTION_A_PLAN.md`
6. `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md`

---

## Core implementation files to review

1. `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
2. `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
3. `packages/plugins/commerce/src/storage.ts`
4. `packages/plugins/commerce/src/handlers/checkout.ts`
5. `packages/plugins/commerce/src/index.ts`

### Test files that prove critical behaviors

6. `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`
7. `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`

---

## Additional context files

8. `HANDOVER.md` (project handoff context)
9. `commerce-plugin-architecture.md` (architecture context if needed)

---

## Recommended review flow (15–20 minutes)

### Phase 1 — Security gate

- Open `webhooks-stripe.ts` and confirm signature verification runs before finalize state mutation.
- Confirm missing/invalid signatures are rejected with `WEBHOOK_SIGNATURE_INVALID`.

### Phase 2 — Correctness path

- Open `finalize-payment.ts` and confirm:
  - preflight stock checks happen first
  - inventory movement IDs are deterministic
  - movement writes are replay-safe
  - order state only transitions to paid after stock and ledger paths complete

### Phase 3 — Determinism and idempotency

- Validate `markPaymentAttemptSucceeded` selection uses deterministic filters and ordering.
- Confirm duplicate webhook events route to replay/terminal semantics without duplicate stock effects.

### Phase 4 — Storage and constraints

- Confirm ledger and stock indexes in `storage.ts` support deterministic recovery paths and duplicate-suppression.
- Verify storage contract assumptions before signing off.

### Phase 5 — Tests

- Validate added tests cover:
  - signature parsing/validation
  - stale or malformed signatures
  - earliest pending attempt selection
  - preflight failure leaves stock/ledger unchanged

---

## Review pass/fail matrix (copy into working notes)

1. `WEBHOOK_SIGNATURE_INVALID` is correctly returned for malformed/missing/invalid signatures.
2. Invalid finalize attempts do not write receipt/order/stock/ledger side effects.
3. Duplicate webhook deliveries are replay-safe and do not cause duplicate ledger mutations.
4. No partial stock update when preflight fails.
5. Payment-attempt update is deterministic across multiple pending attempts.
6. Residual concurrency race window is accepted explicitly with a follow-up action if needed.

Mark each item as Pass/Fail/Needs follow-up and capture owner.

---

## Files and owners to share with findings

Use this exact format while reviewing:

- Reviewer:
- Date:
- Environment:
- Test command run:
- Pass/Fail:
- Risks:
- Suggested follow-up:

---

## Delivery artifacts

- `latest-code-4.zip` (recommended single archive to share; includes all repository files needed for review)
- This document: `THIRD_PARTY_REVIEW_PACKAGE.md`

---

## Known residual risk

Current storage contract does not yet provide true CAS/atomic claim primitives in this path.
That means a narrow simultaneous delivery race can still overlap in the final write window.
This is documented and should be accepted explicitly or scheduled as next-phase work.

---

## Final recommendation output template

1. Go/No-Go recommendation for current rollout:
2. Immediate fixes required (if any):
3. Follow-up items (if acceptable with residual risk):
4. Owner + target date for each follow-up:

