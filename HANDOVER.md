# HANDOVER

## 1) Purpose

This repository is the EmDash commerce plugin with a stage-1 money-path and a pending catalog-spec implementation track. The current problem is to complete the v1 catalog model while keeping checkout/finalize behavior unchanged and deterministic.

The immediate scope is to keep the kernel narrow (`cart` → `checkout` → webhook finalize), enforce strict possession and replay contracts, and add the catalog foundation required by `emdash-commerce-product-catalog-v1-spec-updated.md` in incremental phases.

## 2) Completed work and outcomes

Money-path kernel work remains intact and is regression-covered:

- Core route surface: `cart/upsert`, `cart/get`, `checkout`, `checkout/get-order`, `webhooks/stripe`, `recommendations`.
- Ownership and possession checks continue through `ownerToken/ownerTokenHash` and `finalizeToken/finalizeTokenHash`.
- Replay safety and conflict handling are in place for webhook/checkout recovery, including `restorePendingCheckout` drift checks.

Catalog phase-1 foundation is now implemented and wired into plugin registration:

- Storage: `products` and `productSkus` collections added in `src/storage.ts` with indexing contracts.
- Domain shape: `StoredProduct` and `StoredProductSku` added to `src/types.ts`.
- Validation: product and SKU create/list/get input schemas added in `src/schemas.ts`.
- Handlers: `createProductHandler`, `getProductHandler`, `listProductsHandler`, `createProductSkuHandler`, `listProductSkusHandler` in `src/handlers/catalog.ts`.
- Route exposure: `catalog/product/create`, `catalog/product/get`, `catalog/products`, `catalog/sku/create`, `catalog/sku/list` in `src/index.ts`.
- Regression: index coverage and catalog handler behavior tests added in `src/contracts/storage-index-validation.test.ts` and `src/handlers/catalog.test.ts`.

Validation state at handoff:

- `pnpm --filter @emdash-cms/plugin-commerce test src/handlers/catalog.test.ts src/contracts/storage-index-validation.test.ts` passed.
- `pnpm --filter @emdash-cms/plugin-commerce test` passed: 25 files, 175 tests passed, 1 skipped.

## 3) Failures, open issues, and lessons learned

No open test regressions are present in `packages/plugins/commerce` at handoff. Remaining implementation gaps are by spec phase, not defects:

- Phase-2+ work is still pending for media/assets, option matrix, digital assets/entitlements, bundle composition, and catalog-to-order snapshot integration.
- Product catalog read APIs are currently non-cursor paginated and return sorted filtered arrays.
- Snapshot correctness against historical mutable catalog rows is not yet implemented in order lines.

Lessons carried forward from this phase:

- Keep all changes to idempotency, possession, and replay logic test-first.
- Preserve scope lock: do not broaden provider/runtime topology before explicit roadmap gate.
- Prefer additive catalog changes that remain aligned to current storage and handler contracts.

## 4) Files changed, key insights, and gotchas

High-impact files for continuation:

- `packages/plugins/commerce/src/storage.ts`
- `packages/plugins/commerce/src/types.ts`
- `packages/plugins/commerce/src/schemas.ts`
- `packages/plugins/commerce/src/handlers/catalog.ts`
- `packages/plugins/commerce/src/handlers/catalog.test.ts`
- `packages/plugins/commerce/src/contracts/storage-index-validation.test.ts`
- `packages/plugins/commerce/src/index.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/handlers/checkout.ts`
- `packages/plugins/commerce/src/handlers/cart.ts`
- `packages/plugins/commerce/src/handlers/checkout-get-order.ts`
- `packages/plugins/commerce/src/handlers/webhook-handler.ts`
- `packages/plugins/commerce/src/handlers/checkout-state.ts`
- `packages/plugins/commerce/src/handlers/checkout-state.test.ts`
- `packages/plugins/commerce/src/contracts/commerce-kernel-invariants.test.ts`

Gotchas to avoid:

- Product and SKU IDs are generated with `prod_` and `sku_` prefixes plus `randomHex` suffixes; keep token/ID assumptions consistent in tooling.
- SKU creation is blocked for missing products and archived products.
- Handler-level uniqueness checks for slugs and SKU codes remain a required invariant even with storage unique indexes.
- Existing order/cart line item model is still primitive and has not been replaced by snapshot-rich line schema.

## 5) Key files and directories

Primary package:

- `packages/plugins/commerce/`

Core runtime:

- `packages/plugins/commerce/src/handlers/`
- `packages/plugins/commerce/src/orchestration/`
- `packages/plugins/commerce/src/lib/`
- `packages/plugins/commerce/src/contracts/`
- `packages/plugins/commerce/src/types.ts`
- `packages/plugins/commerce/src/schemas.ts`

Reference and governance docs:

- `packages/plugins/commerce/HANDOVER.md` (this file)
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `packages/plugins/commerce/COMMERCE_EXTENSION_SURFACE.md`
- `packages/plugins/commerce/COMMERCE_AI_ROADMAP.md`
- `packages/plugins/commerce/CI_REGRESSION_CHECKLIST.md`
- `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`
- `@THIRD_PARTY_REVIEW_PACKAGE.md`
- `external_review.md`
- `SHARE_WITH_REVIEWER.md`
- `commerce-plugin-architecture.md`
- `3rd-party-checklist.md`
- `emdash-commerce-third-party-review-memo.md`
- `scripts/build-commerce-external-review-zip.sh`
