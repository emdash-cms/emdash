# 3rd Party Share Index (v4)

## Package
- `latest-code_4.zip` (review scope: schema-contract-to-kernel alignment for first Stripe slice)

## Why this version
- This is the successor to `latest-code_3.zip` and aligns file names/references to `3rdpary_review_4.md`.

## Review flow (recommended)

1. Read context and expectations
   - `3rdpary_review_4.md`
   - `HANDOVER.md`
   - `latest-code_4_review_instructions.md`
   - `commerce-plugin-architecture.md`

2. Validate error-code contract and route-level safety
   - `packages/plugins/commerce/src/kernel/errors.ts`
   - `packages/plugins/commerce/src/kernel/errors.test.ts`
   - `packages/plugins/commerce/src/kernel/api-errors.ts`
   - `packages/plugins/commerce/src/kernel/api-errors.test.ts`

3. Validate finalize behavior and idempotent path
   - `packages/plugins/commerce/src/kernel/finalize-decision.ts`
   - `packages/plugins/commerce/src/kernel/finalize-decision.test.ts`

4. Validate rate limiting and abusive-use safeguards
   - `packages/plugins/commerce/src/kernel/limits.ts`
   - `packages/plugins/commerce/src/kernel/rate-limit-window.ts`
   - `packages/plugins/commerce/src/kernel/rate-limit-window.test.ts`

5. Validate supporting helpers and defaults
   - `packages/plugins/commerce/src/kernel/idempotency-key.ts`
   - `packages/plugins/commerce/src/kernel/idempotency-key.test.ts`
   - `packages/plugins/commerce/src/kernel/provider-policy.ts`

6. Validate route-aligned direction from platform patterns
   - `packages/plugins/forms/src/index.ts`
   - `packages/plugins/forms/src/storage.ts`
   - `packages/plugins/forms/src/schemas.ts`
   - `packages/plugins/forms/src/handlers/submit.ts`
   - `packages/plugins/forms/src/types.ts`

7. Validate integration references and governance
   - `AGENTS.md`
   - `skills/creating-plugins/SKILL.md`

## What this review should decide

1. Whether helper-level correctness is sufficient for phase-1 risk profile.
2. Whether error mapping and response-contract strategy is explicit and safe.
3. Whether implementation is ready to proceed to storage-backed Stripe orchestration.
4. Whether any blockers exist for next milestone:
   - order/payment/webhook persistence
   - idempotent finalize orchestration
   - webhook replay/conflict behavior
   - inventory/ledger correctness

## Quick verdict form

- Architecture alignment: PASS / CONCERNS / FAIL
- Kernel readiness for phase-1 integration: PASS / CONCERNS / FAIL
- Biggest risk at handoff: __________________________
- Recommended next milestone order (if not already followed): __________________________________

