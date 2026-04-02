# Files to share with 3rd-party reviewer

## Recommended share set (minimal + complete)

### 1) Highest priority first (must-read)

1. `README_REVIEW.md`
2. `3rd-party-checklist.md`
3. `3rdpary_review-4.md`
4. `COMMERCE_REVIEW_OPTION_A_PLAN.md`
5. `COMMERCE_REVIEW_OPTION_A_EXECUTION_NOTES.md`

### 2) Core implementation under review

6. `packages/plugins/commerce/src/index.ts`
7. `packages/plugins/commerce/src/handlers/webhooks-stripe.ts`
8. `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
9. `packages/plugins/commerce/src/storage.ts`
10. `packages/plugins/commerce/src/handlers/checkout.ts`

### 3) Test coverage added for this pass

11. `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
12. `packages/plugins/commerce/src/handlers/webhooks-stripe.test.ts`

### 4) Artifact zip (single-file option)

13. `latest-code-4.zip`

## Optional: if you want just one file transfer

Share only `latest-code-4.zip`; it contains the repo state and all relevant files above.

