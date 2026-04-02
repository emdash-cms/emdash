# 3rd-Party Review Guide — EmDash Commerce Finalize Hardening

Use this as the first file when evaluating the current Option A implementation.

## Goal

Validate whether the Stripe webhook finalize hardening in `packages/plugins/commerce` is production-ready and identify the minimal next improvements.

## Start here (must read first)

- `3rdpary_review-4.md` (ecosystem context, risk framing, suggested review sequence)
- `3rd-party-checklist.md` (one-page pass/fail matrix with owners)
- `COMMERCE_REVIEW_OPTION_A_PLAN.md` (historical implementation plan and status)
- `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md` (current residual risk + rollout notes)

## Files to inspect next

- `packages/plugins/commerce/src/index.ts`
- `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/storage.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`
- `packages/plugins/commerce/src/handlers/checkout.ts` (input sanity checks)

## Suggested review flow (10–15 minutes)

1. Read the four docs above to align on intent and residual risk.
2. Confirm the security gate in webhook handler (`WEBHOOK_SIGNATURE_INVALID` path).
3. Walk through deterministic inventory preflight and movement IDs in finalize orchestration.
4. Verify tests cover:
   - signature validation
   - duplicate delivery behavior
   - insufficient stock/version mismatch
   - deterministic payment attempt selection
5. Note any gaps, then map each to severity and owner in `3rd-party-checklist.md`.

## Current review status snapshot

- Core hardening and checks are implemented and committed.
- One residual concurrency race risk remains for perfectly simultaneous duplicates under current storage capabilities.
- Decision point: whether that residual is acceptable for target traffic, or if a storage-level claim/CAS hardening phase should be added next.

## Evaluation output expectation

- Include expected verdict for each checklist item.
- Call out any failing edge case and the minimal code/test change needed.
- Return one "go / hold / needs follow-up" decision with a concise owner assignment.

