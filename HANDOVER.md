# HANDOVER

## 1) Project status: purpose and current problem

This repository hosts an EmDash-native commerce plugin with a narrow stage-1 scope: deterministic checkout and webhook-driven payment finalization for Stripe using storage-backed state. The current objective is to make the transaction core repeatable under partial-failure and duplicate-delivery conditions before expanding scope.

The implementation targets the following problem domain: order creation, payment attempt tracking, inventory deduction, idempotent webhook replay handling, and consistent API-level error and status semantics in the finalize path.

## 2) Completed work and outcomes

The stage-1 commerce slice is implemented in `packages/plugins/commerce` and validated with targeted test coverage.

- Checkout handler (`packages/plugins/commerce/src/handlers/checkout.ts`) now persists deterministic idempotency states and recovers missing partial-order artifacts from pending idempotency records.
- Finalization orchestration (`packages/plugins/commerce/src/orchestration/finalize-payment.ts`) now uses explicit decision branches for replay/invalid/token/partial states and includes an operational recovery helper `queryFinalizationStatus(...)`.
- Inventory reconciliation now handles the edge case where a ledger row is written but stock update is not completed, by finishing the missing stock mutation on retry.
- Receipt state semantics are documented in code comments and in kernel decision docs so `pending` is explicit as resumable state.
- `finalizePaymentFromWebhook` now has explicit log coverage on core exit paths, including the intentionally bubbled final `processed` receipt write.
- Targeted test suite now includes failure-path validation for:
  - ledger exists + stock write fail + retry
  - final receipt `processed` write fail + retry
  - same-event concurrent finalize attempts and documented behavior
- `HANDOVER.md` was updated to support external continuation and handoff.

Validated commands:

```bash
cd packages/plugins/commerce
pnpm --filter "./packages/plugins/commerce" test -- src/handlers/checkout.test.ts src/orchestration/finalize-payment.test.ts
pnpm typecheck
```

Latest hardening pass validation (applies to webhook raw-body enforcement + finalize logging + runbook updates):

- `pnpm --filter "./packages/plugins/commerce" test -- src/handlers/checkout.test.ts src/orchestration/finalize-payment.test.ts`
  - `14 test files, 68 tests passed`
- `pnpm --filter "./packages/plugins/commerce" typecheck`
  - `tsc --noEmit` success

## 3) Failures, open issues, and lessons learned

- Open design risk remains: concurrent same-event finalize across separate workers/processes can still race before claim-write visibility; storage-level claim primitives are not guaranteed by current EmDash storage interface.
- `pending` is not terminal and must be treated as resumable.
- Do not treat `put()` as an atomic claim primitive.
- `error` receipt state is currently a narrow terminal marker used when the order row disappears during finalize replay.
- Final-mile receipt writes are now tested and retry-safe by design, but still need platform support for stronger duplicate prevention in distributed delivery.

Lesson learned: do not expand scope until replay/partial-failure behavior remains deterministic and tests pass for the negative paths.

## 4) Files changed, key insights, and gotchas

Primary implementation references:

- `packages/plugins/commerce/src/handlers/checkout.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- `packages/plugins/commerce/src/kernel/api-errors.ts`
- `packages/plugins/commerce/src/kernel/errors.ts`
- `packages/plugins/commerce/src/kernel/finalize-decision.ts`

Key insights:

- Keep orchestration/state transitions centralized in the kernel/handler boundary.
- Keep route handlers as contract and serialization layers (`toCommerceApiError()`).
- Keep enums and states narrow; add transitions only when backed by tests.
- Failure handling must be explicit and idempotent, not best-effort.

Gotchas:

- Invalid rate-limit inputs and idempotency values should fail safely.
- `pending` receipts need inspection logic before marking as terminal.
- Do not assume external webhook claims are globally serialized by storage.
- Do not broaden scope to shipping/tax/bundles/MCP until finalize core is stable.

## 5) Key files and directories

### Core
- `packages/plugins/commerce/package.json`
- `packages/plugins/commerce/tsconfig.json`
- `packages/plugins/commerce/vitest.config.ts`
- `packages/plugins/commerce/src/`

### Commerce docs and onboarding
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK.md`
- `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK_SUPPORT.md`
- `packages/plugins/commerce/AI-EXTENSIBILITY.md`
- `commerce-plugin-architecture.md` (architecture reference)

### Review/context notes now in-repo
- `3rdpary_review_3.md`
- `CHANGELOG_REVIEW_NOTES.md`
- `latest-code_3_review_instructions.md`

## Next developer execution order

1. Run `pnpm install` at repo root.
2. Run the validation commands above.
3. Continue hardening finalize behavior only; do not change product scope.
4. Maintain compatibility between runtime behavior and docs (especially state semantics and failure handling).

