# EmDash Commerce Plugin — Fresh-Eyes Sanity Check Review

Date: April 5, 2026  
Scope: Current state of the foundational ecommerce plugin framework in `packages/plugins/commerce`  
Reviewer stance: Validate real issues only. Do not over-engineer. Do not fix what is not broken.

---

## Executive Summary

The current foundation is generally strong. The codebase shows a clear kernel-oriented structure, a disciplined checkout/finalization path, sensible schema and storage separation, and meaningful test coverage across catalog, checkout, and webhook flows.

This is **not** a case of broad over-engineering.

The main concerns are narrower and concrete:

1. **Inventory currently has split authority** between SKU rows and `inventoryStock`, and those two paths are not being kept in sync.
2. **Catalog read assembly is already N+1 heavy** in several places.
3. **Ordered child mutations** for assets and bundle components use repeated multi-write normalization loops that increase correctness risk and duplication.
4. **`catalog.ts` is becoming a monolith**, which is not yet a failure, but is the main technical-debt pressure point.

The only issue I would classify as a genuine correctness risk right now is **inventory split-brain**. The others are maintainability and scaling issues, not immediate architectural failures.

---

## Objectives Review

This review specifically looked for:

- logic flaws
- edge cases
- performance issues
- technical debt
- duplicated or semi-duplicated data/processes that could be consolidated
- refactoring opportunities that respect EmDash best practices

All recommendations below are based on validated code behavior, not assumptions.

---

## Validated Findings

### 1) Inventory has two sources of truth

This is the highest-risk issue in the current codebase.

### What the code shows

`StoredInventoryStock` is defined as the materialized inventory record:

- `packages/plugins/commerce/src/types.ts:191-207`

`StoredProductSku` also stores inventory state directly on the SKU:

- `packages/plugins/commerce/src/types.ts:241-254`

Checkout validation reads from `inventoryStock`, not SKU inventory fields:

- `packages/plugins/commerce/src/lib/checkout-inventory-validation.ts:33-99`

Finalization also reads and writes `inventoryStock` only:

- `packages/plugins/commerce/src/orchestration/finalize-payment-inventory.ts:42-44`
- `packages/plugins/commerce/src/orchestration/finalize-payment-inventory.ts:72-107`
- `packages/plugins/commerce/src/orchestration/finalize-payment-inventory.ts:157`

SKU create/update handlers write SKU inventory fields, but do not create or synchronize a corresponding `inventoryStock` row in the same flow:

- `packages/plugins/commerce/src/handlers/catalog.ts:996-1035`
- `packages/plugins/commerce/src/handlers/catalog.ts:1037-1061`

Catalog listing derives inventory summaries and low-stock counts from SKU inventory fields:

- `packages/plugins/commerce/src/handlers/catalog.ts:714-722`

### Why this is a real problem

This creates a validated split-brain condition:

- A SKU can be created with inventory on the SKU document but **without** a matching `inventoryStock` row.
- Checkout can reject a purchasable SKU because it only trusts `inventoryStock`.
- Product listing can show stock and low-stock status based on SKU values that may not match the operational stock actually used by checkout/finalization.

This is not hypothetical. The code paths are materially divergent.

### Severity

**High** — correctness and operational consistency.

---

### 2) Catalog read assembly is already N+1 heavy

This is a validated scaling and maintainability concern.

### What the code shows

`getProductHandler` performs multiple nested follow-up reads:

- load product
- query SKUs
- query categories/tags/images
- for variable products, query option rows and images per SKU
- for bundles, load component SKUs individually
- for digital products, query entitlements per SKU and then load digital assets individually

See:

- `packages/plugins/commerce/src/handlers/catalog.ts:538-662`

`listProductsHandler` queries products once, then per product performs additional queries for SKUs, images, categories, and tags:

- `packages/plugins/commerce/src/handlers/catalog.ts:665-729`

`buildOrderLineSnapshots` and related helpers perform repeated per-line and per-component lookups:

- `packages/plugins/commerce/src/lib/catalog-order-snapshots.ts:53-62`
- `packages/plugins/commerce/src/lib/catalog-order-snapshots.ts:83-167`
- `packages/plugins/commerce/src/lib/catalog-order-snapshots.ts:195-255`

### Why this matters

At current scope, this may be acceptable. But the pattern is already repeated enough that it will become expensive and harder to reason about as:

- product count grows
- variable products increase
- bundle composition grows
- digital entitlement usage expands

This is not an emergency rewrite trigger. It is a good candidate for targeted refactoring before the catalog grows much larger.

### Severity

**Medium** — performance and maintainability.

---

### 3) Ordered child mutation logic is duplicated and multi-write fragile

This is a validated technical-debt and consistency risk.

### What the code shows

Asset-link creation, unlink, and reorder all rebuild ordered collections and then rewrite rows in loops:

- `packages/plugins/commerce/src/handlers/catalog.ts:1201-1231`
- `packages/plugins/commerce/src/handlers/catalog.ts:1234-1256`
- `packages/plugins/commerce/src/handlers/catalog.ts:1259-1300`

Bundle-component add, remove, and reorder do the same:

- `packages/plugins/commerce/src/handlers/catalog.ts:1302-1371`
- `packages/plugins/commerce/src/handlers/catalog.ts:1373-1395`
- `packages/plugins/commerce/src/handlers/catalog.ts:1398-1440`

### Why this matters

The logic is reasonable, but it is duplicated and relies on repeated write loops.

Risks:

- partial failure can leave positions half-normalized
- bug fixes must be applied in multiple similar paths
- cognitive overhead increases because the same mutation shape exists in more than one domain area

This is a good consolidation candidate because the duplication is concrete and local.

### Severity

**Medium** — maintainability and mutation safety.

---

### 4) `catalog.ts` is becoming the technical-debt concentration point

This is validated, but it is not yet a correctness issue.

### What the code shows

`catalog.ts` is currently 1,588 lines and mixes:

- product CRUD
- SKU CRUD
- media and asset linking
- category/tag linkage
- bundle management
- digital assets and entitlements
- product read assembly

See file length and content concentration:

- `packages/plugins/commerce/src/handlers/catalog.ts`

### Why this matters

This raises:

- change risk
- review complexity
- missed-path bugs in similar flows
- difficulty onboarding future contributors

However, this should be treated as a **controlled refactor opportunity**, not a sign that the architecture is broken.

### Severity

**Low to Medium** — maintainability.

---

## What Looks Good and Should Not Be Disturbed

These areas look intentional and appropriately structured for the current stage:

- kernel/finalization architecture
- inventory ledger + stock separation as a concept
- idempotency/finalization discipline
- schema-driven input validation
- extension seam direction
- broad route contract shape
- presence of meaningful tests across catalog and checkout flows

I would **not** recommend broad architectural changes in these areas right now.

---

## Refactoring Options

The goal here is to improve the current solution without changing its overall shape.

## Strategy 1 — Harden inventory source-of-truth rules

### Description

Keep the existing solution, but make `inventoryStock` the clearly authoritative operational stock record and eliminate drift between SKU-level inventory fields and `inventoryStock`.

### What this would involve

- Ensure SKU creation also creates the matching `inventoryStock` row.
- Ensure SKU inventory updates either:
  - update both records consistently, or
  - stop treating SKU inventory fields as authoritative in reads.
- Update catalog listing/detail inventory summaries so they read from operational stock or from a dedicated stock read-model assembler.
- Add tests proving SKU create/update cannot leave stock missing or stale.

### Analysis

**Cognitive load:** Low  
**Performance:** Neutral to slightly better  
**DRY:** Moderate improvement  
**YAGNI:** Strong  
**Scalability:** Strong for current stage  
**EmDash fit:** Excellent — clear boundaries, minimal scope, high correctness value

### Verdict

This is the most important refactor.

---

## Strategy 2 — Extract a catalog read assembler layer

### Description

Without changing route contracts, move catalog response composition into dedicated internal read builders/services.

### What this would involve

Create internal helpers for:

- product list assembly
- product detail assembly
- order line snapshot assembly
- shared DTO builders for categories, tags, images, digital entitlements, and bundle summaries

Batch related reads where possible and reuse shared assembly paths.

### Analysis

**Cognitive load:** Medium  
**Performance:** Good improvement potential  
**DRY:** High improvement  
**YAGNI:** Reasonable  
**Scalability:** Materially better  
**EmDash fit:** Good — respects route contracts and modular service boundaries

### Verdict

Good second-phase refactor once correctness issues are stabilized.

---

## Strategy 3 — Consolidate ordered-child mutation flows

### Description

Create one internal mutation helper for ordered child collections and use it for asset links and bundle components.

### What this would involve

Unify the pattern:

1. load ordered rows
2. apply mutation
3. normalize positions
4. persist updated rows
5. assert invariants in tests

Apply this helper to:

- asset add/unlink/reorder
- bundle component add/remove/reorder

### Analysis

**Cognitive load:** Medium-low  
**Performance:** Neutral  
**DRY:** High improvement  
**YAGNI:** Strong  
**Scalability:** Indirectly strong because bug surface shrinks  
**EmDash fit:** Very good — this is a clean internal consolidation

### Verdict

Very worthwhile. High signal, low scope expansion.

---

## Strategy 4 — Split `catalog.ts` into bounded modules

### Description

Keep behavior the same, but split the handler file into narrower domain modules.

### Suggested split

- `catalog-products.ts`
- `catalog-skus.ts`
- `catalog-media.ts`
- `catalog-taxonomy.ts`
- `catalog-bundles.ts`
- `catalog-digital.ts`
- `catalog-read.ts`

### Analysis

**Cognitive load:** Best long-term  
**Performance:** Neutral  
**DRY:** Moderate unless combined with Strategies 2 or 3  
**YAGNI:** Acceptable only if done mechanically  
**Scalability:** Strong for future contributor velocity  
**EmDash fit:** Good, but less urgent than correctness consolidation

### Verdict

Useful, but not first.

---

## Recommendation

## Recommended sequence

### First: Strategy 1
Fix inventory consistency first.

Why:

- It addresses the only clearly validated correctness flaw.
- It removes split authority between display-level and operational inventory.
- It reduces the chance of shipping a catalog that looks correct but fails at checkout.

### Second: Strategy 3
Consolidate ordered-child mutation logic.

Why:

- The duplication is real.
- The consolidation is local and low-risk.
- It improves DRY and reduces maintenance burden without widening scope.

### Third: Strategy 2, only if needed soon
Extract read assembly if catalog complexity is actively growing.

Why:

- It is valuable, but not as urgent as correctness and duplication reduction.
- It should be done based on real pressure, not speculative elegance.

### Fourth: Strategy 4, only as a mechanical cleanup
Split `catalog.ts` after the higher-value refactors are done.

Why:

- This is about maintainability, not rescuing a broken design.
- Done too early, it risks generating churn without enough payoff.

---

## Best Single Recommendation

If choosing only one refactor right now:

# Choose Strategy 1 — inventory source-of-truth hardening

This is the best 10x-engineer recommendation because it solves the highest-risk issue with the least architectural disruption.

It is:

- validated by the current code
- high leverage
- not over-engineered
- fully aligned with the instruction to avoid fixing what is not broken

---

## Concrete "Do Not Over-Engineer" Guidance

To stay disciplined, avoid these moves for now:

- do not redesign the storage model
- do not introduce a generalized repository abstraction everywhere
- do not rewrite checkout/finalize flow
- do not add broad caching infrastructure prematurely
- do not split files just for aesthetics
- do not replace working route contracts

The right move is targeted improvement, not reinvention.

---

## Final Bottom Line

This project is in good shape as a foundational commerce plugin.

It does **not** need a major architectural reset.

The best next step is to correct the validated inventory consistency issue, then consolidate the repeated ordered-child mutation logic. After that, reassess whether catalog read assembly is large enough to justify extraction.

That path gives the strongest improvement in correctness, maintainability, and future safety while remaining DRY, YAGNI-compliant, and faithful to EmDash best practices.
