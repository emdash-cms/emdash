# Third-Party Review Instructions for latest-code_4

## Purpose

This review package is scoped to validate the correctness-first commerce kernel slice and its alignment with
`HANDOVER.md` and `commerce-plugin-architecture.md` before broader phase expansion.

## Priority Review Order

1. Read `3rdpary_review_4.md` first.
2. Confirm architecture contract in:
   - `HANDOVER.md`
   - `commerce-plugin-architecture.md`
3. Verify implementation in kernel files:
   - `packages/plugins/commerce/src/kernel/errors.ts`
   - `packages/plugins/commerce/src/kernel/limits.ts`
   - `packages/plugins/commerce/src/kernel/rate-limit-window.ts`
   - `packages/plugins/commerce/src/kernel/rate-limit-window.test.ts`
   - `packages/plugins/commerce/src/kernel/finalize-decision.ts`
   - `packages/plugins/commerce/src/kernel/finalize-decision.test.ts`
4. Validate helper contracts and extension boundaries:
   - `packages/plugins/commerce/src/kernel/idempotency-key.ts`
   - `packages/plugins/commerce/src/kernel/idempotency-key.test.ts`
   - `packages/plugins/commerce/src/kernel/provider-policy.ts`
5. Compare implementation style with reference plugin patterns in forms:
   - `packages/plugins/forms/src/index.ts`
   - `packages/plugins/forms/src/storage.ts`
   - `packages/plugins/forms/src/schemas.ts`
   - `packages/plugins/forms/src/handlers/submit.ts`
   - `packages/plugins/forms/src/types.ts`

## Core Questions to Answer

- Do error codes in `COMMERCE_ERRORS` fully represent the failure states planned in architecture?
- Is rate limiting behavior truly fixed-window and is that explicit in tests?
- Does `decidePaymentFinalize()` produce deterministic outcomes for:
  - already-paid orders,
  - webhook replay/duplicate,
  - pending/error webhook receipts,
  - non-finalizable payment phases?
- Are state-machine transitions explicit and closed to invalid transitions?
- Do plugin patterns match EmDash guidance (`AGENTS.md`, `skills/creating-plugins/SKILL.md`)?

## Expected Artifacts in this Zip

The package is intentionally limited to documents and code needed for third-party architectural review,
not to include every workspace file.

