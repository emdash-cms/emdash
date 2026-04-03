# HANDOVER

## 1) Goal and problem statement

This project is a stage-1 EmDash commerce kernel plugin. Its purpose is a minimal, opinionated money path:

- `cart/upsert` and `cart/get` for guest possession-driven cart state,
- `checkout` for deterministic, idempotent order creation,
- `checkout/get-order` for secure readback,
- `webhooks/stripe` for payment-finalization entry.

The current problem is to move the plugin from “strong foundation” to reliable next-phase ownership: keep the transaction core closed, extend around it, and improve confidence before adding broader feature slices.

The next developer should not broaden finalize semantics. Changes should be adjacent: route extensions, test hardening, storefront wiring, and operational/debugging around known residual risks.

## 2) Completed work and outcomes

The stage-1 kernel is implemented and guarded by tests in `packages/plugins/commerce`.

- Core runtime is centralized in `src/handlers/checkout.ts`, `src/handlers/checkout-get-order.ts`, `src/handlers/webhooks-stripe.ts`, `src/orchestration/finalize-payment.ts`, and `src/handlers/webhook-handler.ts`.
- Possession is enforced with `ownerToken`/`ownerTokenHash` for carts and `finalizeToken`/`finalizeTokenHash` for order reads.
- Runtime crypto for request paths uses the async `lib/crypto-adapter.ts`; Node-only `src/hash.ts` is now quarantined as legacy/internal and explicitly deprecated.
- Duplicate/replay handling is documented and tested; pending receipt semantics are documented in `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`.
- Type-cast leakage is intentionally isolated (primarily in `src/index.ts`).
- Review packaging is now narrowed around one canonical packet; external docs are reduced to an operational entrypoint set.
- Test suite for commerce package is passing (`19` files, `102` tests).

## 3) Failures, open issues, and lessons learned

- **Known residual risk (not fixed): same-event concurrent webhook delivery**. Storage does not provide an insert-if-not-exists/CAS primitive in this layer, so two workers can still race before a durable claim is established. Risk is contained by deterministic writes and explicit diagnostics, but not fully eliminated.
- **Receipt state is sharp:** `pending` is both claim marker and resumable state. This is intentional and working, but future edits must preserve the meaning exactly.
- **Hash strategy is split by design:** `crypto-adapter.ts` is the preferred runtime path; `src/hash.ts` is legacy compatibility only.
- **Failure handling lesson:** avoid edits to finalize/checkout without a reproducer test. Use negative-path and recovery tests first for any behavioral change.

## 4) Files changed, key insights, and gotchas

No broad churn was introduced in this handoff window; changes are narrow and additive. Important implementation points:

- `packages/plugins/commerce/src/hash.ts`
  - Kept as Node-only legacy helper, now clearly deprecated for new code.
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`
  - Added concurrency stress/replay coverage and async hashing setup for test fixtures.
- `packages/plugins/commerce/src/handlers/cart.test.ts`
- `packages/plugins/commerce/src/handlers/checkout.test.ts`
- `packages/plugins/commerce/src/handlers/checkout-get-order.test.ts`
  - Migrated test hashing setup to `crypto-adapter` async APIs.
- `scripts/build-commerce-external-review-zip.sh`
  - Zip now includes a canonical document set only.

Gotchas:

- Do not rely on `finalizeTokenHash` in response payloads; `checkout/get-order` strips it by design.
- Do not add speculative abstraction inside finalize/checkout before failure/replay tests exist.
- Preserve route/route-handler boundaries: handler files remain I/O and validation; orchestration/kernels carry transaction semantics.

## 5) Key files and directories

- **Primary package:** `packages/plugins/commerce/`
- **Runtime code:** `packages/plugins/commerce/src/`
- **Canonical external packet:** `@THIRD_PARTY_REVIEW_PACKAGE.md`
- **Commerce docs index:** `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- **Kernel/seam references:** `packages/plugins/commerce/COMMERCE_EXTENSION_SURFACE.md`
- **Receipt recovery audit:** `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`
- **Zip artifact for handoff:** `commerce-plugin-external-review.zip`

## 6) Onboarding order for next developer

1. Read this file, then `@THIRD_PARTY_REVIEW_PACKAGE.md`, then `README_REVIEW.md`.
2. Verify from `packages/plugins/commerce`:
   - `pnpm install`
   - `pnpm test`
   - `pnpm typecheck`
3. Confirm `packages/plugins/commerce/README_REVIEW.md` and `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md` route tables if storefront/docs integration is part of the next step.
4. For changes: keep money-path closed, add focused regression tests first, and update docs only where behavior changed.
