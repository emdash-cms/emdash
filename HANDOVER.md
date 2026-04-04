# HANDOVER

## 1) Purpose

This repository is a Stage-1 EmDash commerce plugin core.
Current problem scope is to keep the money path narrow and deterministic (`cart` → `checkout` → webhook finalization), with strict possession checks and idempotent replay behavior.

The immediate objective is to continue hardening reliability and maintainability without changing checkout/finalize semantics, while preserving the existing production-safe route boundaries.

## 2) Completed work and outcomes

Core kernel and money-path behavior are implemented and test-guarded:

- Routes: `cart/upsert`, `cart/get`, `checkout`, `checkout/get-order`, `webhooks/stripe`, `recommendations`.
- Ownership enforcement via `ownerToken/ownerTokenHash` and `finalizeToken/finalizeTokenHash`.
- Receipt-driven replay and finalization semantics with terminal error handling for irreversible inventory conditions.
- Contract hardening completed for provider defaults, adapter contracts, and extension seam exports.
- Reviewer package updated to canonical flow and include current review memo:
  - `@THIRD_PARTY_REVIEW_PACKAGE.md`
  - `external_review.md`
  - `SHARE_WITH_REVIEWER.md`
  - `HANDOVER.md`
  - `commerce-plugin-architecture.md`
  - `3rd-party-checklist.md`
  - `COMMERCE_DOCS_INDEX.md`
  - `CI_REGRESSION_CHECKLIST.md`
  - `emdash-commerce-third-party-review-memo.md`

Latest validation commands available in this branch:
- `pnpm --filter @emdash-cms/plugin-commerce test`
- `pnpm --filter @emdash-cms/plugin-commerce test services/commerce-provider-contracts.test.ts`
- `pnpm --silent lint:quick`
- `pnpm --silent lint:json` remains blocked by environment/toolchain behavior (`oxlint-tsgolint` SIGPIPE path) in this environment.

Branch artifact metadata:
- Commit: `7a0fac7`
- Updated: 2026-04-03
- Review archive builder: `./scripts/build-commerce-external-review-zip.sh`
- Shareable artifact: `./commerce-plugin-external-review.zip`

## 3) Failures, open issues, and lessons learned

Known residual risk remains:
- same-event concurrent duplicate webhook delivery can race due to storage constraints (no CAS/insert-if-not-exists primitive, no multi-document transactional boundary).
- `pending` remains a high-sensitivity state: it is both claim marker and resumable recovery marker.
- `receipt.error` is intentionally terminal to prevent indefinite replay loops.

Key lessons for next work:
- Keep changes to idempotency/payment/finalization paths test-first.
- Avoid changing behavior in these paths before replay, concurrency, and possession regression tests are updated.
- Preserve current scope lock: provider/runtime expansion only when explicitly approved by roadmap gate.

## 4) Files changed, key insights, and gotchas

Files of highest relevance for next development:

- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- `packages/plugins/commerce/src/handlers/checkout.ts`
- `packages/plugins/commerce/src/handlers/cart.ts`
- `packages/plugins/commerce/src/handlers/checkout-get-order.ts`
- `packages/plugins/commerce/src/handlers/webhook-handler.ts`
- `packages/plugins/commerce/src/services/commerce-provider-contracts.ts`
- `packages/plugins/commerce/src/services/commerce-provider-contracts.test.ts`
- `packages/plugins/commerce/src/services/commerce-extension-seams.ts`
- `packages/plugins/commerce/src/services/commerce-extension-seams.test.ts`
- `packages/plugins/commerce/src/lib/finalization-diagnostics-readthrough.ts`
- `packages/plugins/commerce/src/lib/rate-limit-identity.ts`
- `packages/plugins/commerce/src/lib/crypto-adapter.ts`
- `packages/plugins/commerce/src/contracts/commerce-kernel-invariants.test.ts`
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `packages/plugins/commerce/COMMERCE_EXTENSION_SURFACE.md`
- `packages/plugins/commerce/AI-EXTENSIBILITY.md`
- `packages/plugins/commerce/CI_REGRESSION_CHECKLIST.md`
- `scripts/build-commerce-external-review-zip.sh`
- `emdash-commerce-third-party-review-memo.md`

Gotchas:
- Do not alter `pending`/`error` contracts without updating finalization replay coverage.
- Do not broaden runtime topology in this phase.
- Keep the review packet canonical:
  - `scripts/build-commerce-external-review-zip.sh` is the source of truth for external handoff artifacts.
- Do not assume `lint:json` results are trustworthy until the environment/toolchain issue is resolved.

## 5) Key files and directories

Primary package: `packages/plugins/commerce/`

Runtime/kernel:
- `packages/plugins/commerce/src/handlers/`
- `packages/plugins/commerce/src/orchestration/`
- `packages/plugins/commerce/src/lib/`
- `packages/plugins/commerce/src/types.ts`
- `packages/plugins/commerce/src/schemas.ts`

Strategy and reference docs:
- `packages/plugins/commerce/COMMERCE_EXTENSION_SURFACE.md`
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `@THIRD_PARTY_REVIEW_PACKAGE.md`
- `external_review.md`
- `SHARE_WITH_REVIEWER.md`
- `commerce-plugin-architecture.md`
- `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`
- `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK*.md`
- `3rd-party-checklist.md`

## 6) Single-file onboarding playbook (new developer)

Start state:
- This file (`HANDOVER.md`) is the only handoff narrative required.
- Do not introduce a second parallel onboarding route unless scope changes.

Immediate sequence:
1. Read section 4 and section 5 of this document first to understand touched surfaces and boundaries.
2. Review `packages/plugins/commerce/CI_REGRESSION_CHECKLIST.md` and execute sections in order:
   - `5A` Concurrency and duplicate-event safety.
   - `5B` Pending-state contract safety.
   - `5C` Ownership boundary hardening.
   - `5D` Scope gate before any money-path expansion.
3. Confirm runtime unchanged scope lock is enforced in `Scope lock` and `Definition of done` within the checklist.
4. Run `pnpm --filter @emdash-cms/plugin-commerce test` before any PR.
5. Rebuild and distribute the handoff package with:
   - `./scripts/build-commerce-external-review-zip.sh`

Success criteria for handoff continuity:
- `pending` remains both claim marker and resumable state.
- Deterministic response behavior for replayed checkout/finalize calls is unchanged.
- Ownership failures continue to reject with stable error shapes and no token leakage.

## 7) External-review packet content (current)

The review package is canonicalized to these root-level files and included plugin source:
- `@THIRD_PARTY_REVIEW_PACKAGE.md`
- `external_review.md`
- `SHARE_WITH_REVIEWER.md`
- `HANDOVER.md` (this file)
- `commerce-plugin-architecture.md`
- `3rd-party-checklist.md`
- `COMMERCE_DOCS_INDEX.md`
- `CI_REGRESSION_CHECKLIST.md`
- `emdash-commerce-third-party-review-memo.md`
- `packages/plugins/commerce/` full source tree (excluding `node_modules`, `.vite`)

