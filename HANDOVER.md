# HANDOVER

## Goal

The repository is implementing a native commerce slice on EmDash with a narrow scope: storage-backed checkout, deterministic webhook finalization, and idempotent side effects for Stripe purchases. The immediate problem addressed in this phase is replay-safe payment finalization under partial-failure and duplicate-delivery conditions, before adding broader storefront features.

This stage prioritizes correctness of the payment path over feature breadth. The accepted design remains **kernel-first** with `payment-first` inventory application, single authoritative finalize orchestration, and `idempotent keys + receipt state` driving safe replays.

## Completed work and outcomes

Stage-1 is stable enough for handoff at the commerce plugin layer, with current status reflected in these recent commits: `d7b2bdf`, `632c4eb`, `159dc0f`, and `8f2c52b`.

Current implementation state:

- `packages/plugins/commerce/src/handlers/checkout.ts`: deterministic checkout idempotency replay and safe recovery of missing order/payment-attempt records from a pending idempotency key.
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`: idempotent finalize orchestration with explicit decision flow, stricter receipt-state documentation, and operational recovery helper.
  - `queryFinalizationStatus(...)` added for four-point recovery checks.
  - Inventory reconciliation logic hardened for `ledger exists + stock not yet updated` and replaying `stock write` completion.
  - Receipt state handling clarified (`pending`, `processed`, `error`, `duplicate`) at orchestration boundary.
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`: expanded failure-mode coverage with concurrency + partial-write recovery tests.
  - Added tests that cover: ledger then stock failure/retry, final receipt write failure/retry, and same-event concurrent finalize delivery behavior.
- `HANDOVER.md`: updated with handoff archive, validation checks, and developer onboarding instructions.

Validation commands used for handoff readiness:

```bash
cd packages/plugins/commerce
pnpm test -- handlers/checkout.test.ts orchestration/finalize-payment.test.ts
pnpm typecheck
```

## Failures, open issues, and lessons learned

- Remaining high-risk area is still concurrent same-event webhook finalization across separate processes/Workers. In-process concurrency is now explicit and tested, but platform-level race prevention still requires a storage claim primitive (insert-if-not-exists / conditional writes) for a hard guarantee.
- `pending` receipt is intentionally a resumable state, not a terminal failure state.
- Last-mile receipt-write failures are recoverable by design and now tested.
- Duplicate concurrent finalization for Stripe remains possible on storage implementations without claim-level uniqueness; keep this documented as a platform constraint.

What remains outside scope by design:

- Storefront UI hardening
- bundles/shipping/tax modules
- MCP server/tooling
- second gateway integration (Authorize.net)

## Files changed, key insights, and gotchas

Key insights:
- Preserve state-machine behavior and avoid broadening enums for not-yet-needed domains.
- Keep idempotent logic in orchestration and storage-backed state checks; avoid moving business logic into route handlers or storefront/admin layers.
- Public API errors must use `toCommerceApiError()` and wire-safe error maps in `kernel/errors.ts` + `kernel/api-errors.ts`.
- Treat rate-limit and idempotency inputs as untrusted; invalid values should fail closed.

Gotchas to avoid:
- Do not assume `put()` is atomic claim semantics.
- Do not treat `pending` as terminal.
- Do not remove payment attempt/order/inventory invariants before finalization tests are green.
- Keep docs and architecture in sync: `finalize-payment.ts` comments, `COMMERCE_DOCS_INDEX.md`, and this handover should match behavior.

## Key files and directories

- Core plugin package: `packages/plugins/commerce`
- Checkout handler: `packages/plugins/commerce/src/handlers/checkout.ts`
- Finalize orchestration + tests: `packages/plugins/commerce/src/orchestration/finalize-payment.ts`, `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- Route contracts/errors: `packages/plugins/commerce/src/kernel/api-errors.ts`, `packages/plugins/commerce/src/kernel/errors.ts`
- Kernel decisions: `packages/plugins/commerce/src/kernel/finalize-decision.ts`
- Plugin docs: `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`, `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK.md`, `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK_SUPPORT.md`
- External onboarding context (optional): `commerce-plugin-architecture.md`, `3rdpary_review_3.md`, `CHANGELOG_REVIEW_NOTES.md`, `latest-code_3_review_instructions.md`

## One-document rule for this stage

For stage-1 execution, use this file as the authoritative guide. Use other files only for orientation or deeper architecture context.

## Handover archive

- `emDash-handover-20260402-214800.zip`
- SHA-256: `85b0cebbefd2d1ed37ab49d8be664477705583d5ed98196094bd9ce6d4cfafc8`

The archive includes all tracked repo files and selected review context files (`3rdpary_review_3.md`, `CHANGELOG_REVIEW_NOTES.md`, `latest-code_3_review_instructions.md`), and excludes `.git`, `node_modules`, and build artifacts.

Quick recovery for a successor:

```bash
cd /Users/vidarbrekke/Dev/emDash
{
  git ls-files
  for f in 3rdpary_review_3.md CHANGELOG_REVIEW_NOTES.md latest-code_3_review_instructions.md; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
} | zip -@ emDash-handover-$(date +%Y%m%d-%H%M%S).zip
```

