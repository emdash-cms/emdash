# HANDOVER

## 1) Purpose

This repository is the EmDash v1 commerce plugin in a staged build where the payment/kernel path is intentionally stable and the catalog domain is being completed against `emdash-commerce-product-catalog-v1-spec-updated.md` and follow-up external-review notes. The current problem is to preserve checkout/finalize determinism, idempotency, and possession rules while completing catalog and order-history correctness, especially around transactional behavior for catalog objects like bundles.

The immediate objective for the next developer is to continue from the last merged state with minimal surface expansion: fix known catalog regressions, tighten catalog invariants, and harden bundle/asset/stock behavior without changing the existing cart/checkout/webhook architecture.

## 2) Completed work and outcomes

Phases 1–7 are implemented and wired into the plugin, including product/SKU foundations, assets, variable attributes/options, digital assets/entitlements, bundle composition and pricing, catalog categories/tags/listing/detail retrieval, and checkout-time immutable order snapshots. Bundle transaction-completeness from external review feedback is now in place: bundle cart/checkout validation checks component SKU stock, and finalize-time inventory mutation expands bundles into component SKUs so component stock is decremented consistently when snapshot metadata indicates it.

This was committed as `b101fe4` with root-level docs added for spec and external-review context (`emdash-commerce-product-catalog-v1-spec-updated.md`, `emdash-commerce-external-review-update.md`) and supporting tests across `cart.test.ts`, `checkout.test.ts`, and new `finalize-payment-inventory.test.ts`. Core kernel routes and middleware behavior remain unchanged.

## 3) Failures, open issues, and lessons learned

Current known failures are not in the kernel but in catalog coverage and lint hygiene: `catalog.test.ts` has 12 failing cases in the monorepo test run, and `pnpm --silent lint:quick` reports multiple rule violations (including `no-array-sort`, `prefer-static-regex`, `no-unused-vars`, `no-shadow`, `prefer-array-from-map`, `prefer-spread-syntax`) across touched areas. Remaining open functional work is in domain hardening (not architectural rewrites): slug/SKU code update-time uniqueness and invariants, bundle-discount field constraints on non-bundle products, SKU model completeness (inventory mode/backorder/weight/dimensions/tax class/archived behavior), asset unlink/reorder position normalization, and low-stock logic that currently uses overly broad thresholds.

Recent lessons are to keep domain checks inside shared library/helpers instead of handler-to-handler calls, capture bundle component stock version in snapshot data for forward compatibility, and preserve legacy fallback behavior when snapshots are incomplete so historical order rows can still reconcile safely.

## 4) Files changed, key insights, and gotchas

High-impact changed files after handoff now include:
`packages/plugins/commerce/HANDOVER.md`, `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`, `packages/plugins/commerce/src/handlers/catalog.ts`, `packages/plugins/commerce/src/handlers/catalog.test.ts`, `packages/plugins/commerce/src/handlers/cart.ts`, `packages/plugins/commerce/src/handlers/cart.test.ts`, `packages/plugins/commerce/src/handlers/checkout.ts`, `packages/plugins/commerce/src/handlers/checkout.test.ts`, `packages/plugins/commerce/src/storage.ts`, `packages/plugins/commerce/src/schemas.ts`, `packages/plugins/commerce/src/types.ts`, `packages/plugins/commerce/src/index.ts`, `packages/plugins/commerce/src/lib/catalog-order-snapshots.ts`, `packages/plugins/commerce/src/lib/catalog-bundles.ts`, `packages/plugins/commerce/src/lib/catalog-dto.ts`, `packages/plugins/commerce/src/lib/checkout-inventory-validation.ts`, `packages/plugins/commerce/src/lib/order-inventory-lines.ts`, `packages/plugins/commerce/src/orchestration/finalize-payment-inventory.ts`, `packages/plugins/commerce/src/orchestration/finalize-payment-inventory.test.ts`, `packages/plugins/commerce/src/contracts/storage-index-validation.test.ts`, plus current docs (`prompts.txt`, `external_review.md`, `COMMERCE_DOCS_INDEX.md` references).

Critical gotchas are idempotency and snapshot assumptions: `OrderLineItem.unitPriceMinor` is now aligned with snapshot pricing on checkout write, bundle snapshot component entries include `componentInventoryVersion`, and fallback-only behavior still applies when snapshot metadata is missing; avoid changing these contracts without updating replay-sensitive tests in checkout/finalization paths.

## 5) Key files and directories

Primary development area is `packages/plugins/commerce/`; continuation should focus first on `packages/plugins/commerce/src/lib`, `packages/plugins/commerce/src/handlers`, `packages/plugins/commerce/src/orchestration`, and `packages/plugins/commerce/src/contracts` with schema/type guardrails in `packages/plugins/commerce/src/types.ts` and `packages/plugins/commerce/src/schemas.ts`. For planning and external review alignment, keep `emdash-commerce-product-catalog-v1-spec-updated.md`, `emdash-commerce-external-review-update.md`, and `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md` current when moving into the next phase.
