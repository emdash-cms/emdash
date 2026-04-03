# HANDOVER

## 1) Goal and problem statement

This repository is an EmDash-first Commerce plugin in a Stage-1 kernel state.
Its current objective is to stabilize and extend a narrow, closed money path (cart, checkout, and webhook finalization) while preserving strict ownership and deterministic idempotent behavior.

The immediate next problem to solve is to harden extensibility and maintainability without changing core payment semantics: keep the kernel contracts stable, isolate extension seams, and reduce risk before broader feature rollout (tax/shipping/discount/future gateway expansion).

The next developer should begin by reviewing the codebase for oversized files and weak module boundaries, then prioritize refactoring where boundaries, module sizes, or cohesion block future e-commerce expansion.

## 2) Completed work and outcomes

The core kernel is implemented and test-guarded in `packages/plugins/commerce`.

Cart and checkout primitives are in place (`cart/upsert`, `cart/get`, `checkout`, `checkout/get-order`) with possession required at boundaries.
Finalization is implemented through webhook delivery handling with receipt/state driven replay control, including terminal-state transition handling for known irrecoverable inventory conditions.
Crypto is unified under `src/lib/crypto-adapter.ts`; legacy Node-only hashing (`src/hash.ts`) is removed from active runtime.
Rate-limit identity extraction was centralized in `src/lib/rate-limit-identity.ts` and reused across checkout, webhook handler, and finalization diagnostics.
Docs were cleaned to an EmDash-native canonical review path (`@THIRD_PARTY_REVIEW_PACKAGE.md`, `HANDOVER.md`, `commerce-plugin-architecture.md`, `COMMERCE_DOCS_INDEX.md`, and related packet files).
Recent validation:
- `pnpm test` passed for `@emdash-cms/plugin-commerce` (`21` files, `122` tests).
- Workspace `pnpm test` previously passed in full.
- Full workspace `pnpm typecheck` currently passes.
- `pnpm --silent lint:quick` passes after lint fixes.
- `pnpm --silent lint:json` still fails due a local toolchain/runtime issue (below).

## 3) Failures, open issues, and lessons learned

Known residual risk: same-event concurrent webhook processing remains a storage limitation (no CAS/insert-if-not-exists path in current data model), so parallel duplicate deliveries can still race and rely on deterministic resume semantics plus diagnostic guidance.
Receipt state is a sharp boundary: `pending` is the resumable claim marker and `error` is terminal. Preserve this contract when changing finalize logic.
Lint tooling is inconsistent in this environment:
- `pnpm --silent lint:quick` reports zero diagnostics.
- `pnpm --silent lint:json` exits non-zero because `oxlint-tsgolint` fails with `invalid message type: 97` (SIGPIPE) in this runtime path, so its output cannot be trusted until toolchain/runtime is corrected.
A high-confidence rule from the iteration: every behavioral change in payment/receipt/idempotency paths must be made with failing test first and test updates before code.

## 4) Files changed, key insights, and gotchas

Key files touched in the current handoff window that matter for next development:

- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
- `packages/plugins/commerce/src/handlers/checkout.ts`
- `packages/plugins/commerce/src/handlers/webhook-handler.ts`
- `packages/plugins/commerce/src/lib/finalization-diagnostics-readthrough.ts`
- `packages/plugins/commerce/src/lib/rate-limit-identity.ts`
- `packages/plugins/commerce/src/contracts/commerce-kernel-invariants.test.ts`
- `packages/plugins/commerce/src/services/commerce-extension-seams.test.ts`
- `packages/plugins/commerce/src/lib/crypto-adapter.ts` (canonical hashing path)

Gotchas:
- Keep token handling strict: `ownerToken`/`finalizeToken` are required on mutating/authenticated paths; strict checks are intentional.
- Do not introduce broad abstractions before adding coverage in `src/orchestration/finalize-payment.test.ts`.
- Preserve route boundaries (`src/handlers/*` for I/O and input handling, orchestration for transaction semantics).
- For finalization errors, terminal inventory conditions intentionally move receipt state to `error` to avoid indefinite replay.
- For review/debugging quality, use the first task below before implementing new feature areas.

Initial next-step task:
- Review large/monolithic files for size and cohesion issues, then map extension seams for future modules (discounts, shipping, taxation, recommendations, gateway additions).
- Identify candidate extractions in:
  - `src/handlers/checkout.ts`
  - `src/orchestration/finalize-payment.ts`
  - any files that blend route orchestration, validation, and storage orchestration.

## 5) Key files and directories

Primary package: `packages/plugins/commerce/`

Runtime and kernel files:
- `packages/plugins/commerce/src/handlers/`
- `packages/plugins/commerce/src/orchestration/`
- `packages/plugins/commerce/src/lib/`
- `packages/plugins/commerce/src/types.ts`
- `packages/plugins/commerce/src/schemas.ts`

Decision and extension references:
- `packages/plugins/commerce/COMMERCE_EXTENSION_SURFACE.md`
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `@THIRD_PARTY_REVIEW_PACKAGE.md`
- `external_review.md`
- `SHARE_WITH_REVIEWER.md`
- `commerce-plugin-architecture.md`
- `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`
- `packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK*.md`
