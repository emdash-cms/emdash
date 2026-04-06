# EmDash Commerce Plugin Review Update (Deep Dive)

## Scope

Static deep-dive review of the latest remediation branch/package, with emphasis on:

- bugs and correctness risks
- opportunities for refactoring
- DRY and YAGNI alignment
- removal of legacy / rollout-era behavior
- deployment readiness for first real testing

This review assumes the plugin has **not yet been deployed**, so the standard should be **greenfield-clean** rather than backward-compatibility tolerant.

---

## Executive Summary

This version is **meaningfully improved** over the prior one. Several real runtime legacy paths appear to be removed or neutralized.

However, I would **not yet call the plugin storefront-safe, fully DRY, fully YAGNI, or fully legacy-free**.

The single biggest remaining issue is now the **public read surface**: public catalog routes still appear to expose internal/admin-grade data structures and do not appear to enforce storefront-safe defaults such as `status=active` and `visibility=public`.

So the core risk has shifted:

- **Before:** legacy runtime compatibility paths and public admin mutation exposure
- **Now:** public read-surface design, DTO boundaries, and module structure

---

## What Is Clearly Improved

These changes look materially better than the earlier version:

### 1) Admin mutations are no longer publicly exposed

The route surface in `src/index.ts` is much safer than before. The prior issue where catalog/admin writes were exposed as public now appears largely resolved.

### 2) Stripe webhook legacy compatibility appears removed

The earlier direct-payload compatibility mode for Stripe webhook handling no longer appears to be part of the active runtime path.

### 3) Checkout replay handling is stricter

Cached replay acceptance now appears to require `replayIntegrity`, which is the correct posture for a greenfield release.

### 4) Bundle inventory fallback behavior is stricter

The earlier silent fallback from component-level inventory state to bundle-level fallback stock handling appears to be removed. Failing fast is the right choice.

### 5) Alternate finalize-path rollout behavior appears mostly neutralized

`COMMERCE_USE_LEASED_FINALIZE` now looks more like rollout/history residue than a live runtime fork. That is much healthier than before.

---

## Highest-Priority Remaining Problems

## 1) Public catalog reads still expose internal/admin-grade data

This is now the most important problem in the codebase.

Public routes in `src/index.ts` still include endpoints such as:

- `bundle/compute`
- `catalog/product/get`
- `catalog/products`
- `catalog/sku/list`

But the handlers behind them appear to return **internal storage-grade objects**, not storefront-safe DTOs.

### Why this is a problem

The current shapes appear to expose far more than a public storefront should reveal, including things like:

- `inventoryQuantity`
- `inventoryVersion`
- raw SKU state
- variant matrix internals
- bundle composition internals
- digital entitlement metadata
- inactive / hidden / draft product details

That is both a security/data-exposure concern and a design-boundary problem.

### Why it matters

A storefront API should only reveal what a public buyer actually needs, such as:

- active/public products
- public pricing
- public media
- purchasable options
- availability status at a business level, if desired

It should **not** expose:

- stock concurrency/version tokens
- raw inventory numbers unless intentionally part of the storefront design
- admin-only product states
- internal entitlement structures
- hidden catalog metadata

### Recommendation

Create **separate public and admin DTOs**.

At minimum:

- public routes should return storefront-safe DTOs only
- admin routes should return internal/admin detail DTOs
- `catalog/sku/list` should not expose raw `StoredProductSku[]` on a public route
- `inventoryVersion` should never be exposed publicly

This is the first issue I would fix before deployment.

---

## 2) Public product listing appears to default to “everything”

The product list input schema appears to allow optional `status` and `visibility` filters.

Then `listProductsHandler()` appears to build the query directly from caller input, meaning that if the caller does not specify those filters, the public route may default to returning products without forcing:

- `status = active`
- `visibility = public`

### Why this is a problem

That creates a likely path for exposing:

- draft products
- hidden products
- archived products
- not-yet-ready merchandising data

### Recommendation

For **public storefront routes**, enforce server-side defaults:

- `status = active`
- `visibility = public`

If admin users need broader discovery, give them a separate admin route or admin-only handler mode.

Do not rely on the caller to request safe filters.

---

## 3) The “catalog split” is not a real refactor yet

There are now multiple files such as:

- `catalog-assets.ts`
- `catalog-bundles.ts`
- `catalog-categories.ts`
- `catalog-digital.ts`
- `catalog-products.ts`
- `catalog-tags.ts`

But these appear to function mainly as re-export shims back into `catalog.ts`, not true implementation splits.

### Why this is a problem

This adds file count and indirection without actually reducing complexity.

So the code pays the cost of a multi-file design while still living with a monolithic implementation.

### Recommendation

Choose one of two honest options:

#### Option A — keep the monolith temporarily

If you are not ready to truly split the module, keep `catalog.ts` as the canonical implementation and remove the fake split.

#### Option B — perform a real split

Move real implementations into domain files such as:

- products
- SKUs
- taxonomy
- assets
- bundles
- digital
- shared read-model hydration

Right now it is the worst of both worlds.

---

## 4) Read-model helpers still appear vulnerable to truncation / scaling issues

Several helper functions still appear to use one-shot `query()` calls where the code seems to assume a complete result set.

Examples include read helpers for:

- bundle components
- category DTOs
- tag DTOs
- SKU hydration
- product images by role/target
- SKU option values
- digital entitlement summaries

Elsewhere in the same module, pagination is used more carefully when cardinality is expected to grow.

### Why this is a problem

If the storage adapter ever applies default limits, soft limits, or driver-level caps, these helpers could silently under-read.

That creates brittle behavior that may remain invisible until a catalog grows.

### Recommendation

Create one shared helper for “query all pages until complete” and use it consistently whenever completeness is expected.

This is both a correctness improvement and a DRY improvement.

---

## 5) Storefront reads and admin reads are still mixed together

`getProductHandler()` appears to serve too many concerns at once:

- base product detail
- taxonomy hydration
- images
- variable-product matrix detail
- bundle summary
- digital entitlement summary

### Why this is a problem

This makes it difficult to reason about:

- what is safe to expose publicly
- what is necessary for storefront use
- what is admin-only detail
- what performance cost each caller is paying

It also encourages an “everything endpoint” design.

### Recommendation

Split product read responsibilities into at least two clear paths:

- `getStorefrontProduct()`
- `getAdminProductDetail()`

That would improve:

- safety
- clarity
- performance discipline
- future maintainability

---

## Important Correctness / Robustness Issues

## 6) Product lifecycle logic is duplicated and appears inconsistent

Product lifecycle handling appears split between:

- `updateProductHandler()` via shared patch logic
- `setProductStateHandler()` via hand-rolled transition logic

### Why this is a problem

Duplicated lifecycle logic is a correctness trap.

One likely inconsistency is that a transition to `active` sets `publishedAt` but may not clear `archivedAt`, whereas a transition to `draft` clears `archivedAt`.

If that reading is correct, a previously archived product moved back to active could still carry an old archived timestamp.

### Recommendation

Centralize lifecycle transitions into one authoritative helper used by both handlers.

This is a classic DRY fix that also reduces subtle state bugs.

---

## 7) Ordered-child mutations do not appear atomic

Asset-link and bundle-component mutation flows appear to follow a pattern like:

1. insert/delete child row
2. normalize ordering with `mutateOrderedChildren(...)`

### Why this is a problem

If the first step succeeds and the second fails, the system can be left with:

- gaps in position ordering
- partially normalized children
- ordering drift after deletions
- a state that relies on repair later

### Recommendation

Push the full ordered-child mutation into one authoritative helper so callers do not manage the sequence manually.

If true transactions are unavailable, then at minimum:

- document failure semantics clearly
- provide repair/normalization guarantees
- add strong tests around partial-failure behavior

---

## 8) Variable SKU validation still has avoidable N+1 query behavior

The SKU creation path still appears to perform multiple layered fetches such as:

- attributes
- attribute values per attribute
- option rows per existing SKU

### Why this is a problem

This is not a launch blocker for a modest catalog, but it is a clear opportunity to simplify and reduce query count.

### Recommendation

Batch-load once, then map in memory:

- all relevant attribute values
- all relevant option rows for existing SKUs

That keeps the logic simpler and more scalable.

---

## 9) Error code precision remains weaker than it should be

Some missing-resource situations still appear to map to overly broad codes such as `PRODUCT_UNAVAILABLE`, even when the missing thing is not actually a product.

### Why this is a problem

This hurts:

- observability
- operational debugging
- client-side error handling
- API clarity

### Recommendation

Use narrower, resource-specific codes where possible, such as:

- `ASSET_NOT_FOUND`
- `ENTITLEMENT_NOT_FOUND`
- `BUNDLE_COMPONENT_NOT_FOUND`
- `CATEGORY_LINK_NOT_FOUND`

The system does not need a huge taxonomy, but it should at least distinguish major resource classes.

---

## DRY / YAGNI Opportunities

## 10) Repeated timestamp construction should be centralized

There appears to be repeated use of patterns like:

- `new Date(Date.now()).toISOString()`

throughout the module.

### Why this matters

This is minor, but repetitive timestamp generation:

- adds noise
- weakens consistency
- makes tests harder to stabilize

### Recommendation

Use a tiny helper such as `now_iso()` or inject time where lifecycle logic matters.

Small cleanup, worthwhile.

---

## 11) `catalog.ts` still owns too many responsibilities

Even beyond file size, the module appears to own:

- conflict handling
- stock synchronization
- metadata hydration
- DTO building
- asset ordering
- bundle logic
- digital entitlement logic
- lifecycle logic

### Why this is a problem

This makes the module harder to trust, harder to test, and harder to evolve safely.

### Recommendation

Move toward a structure where responsibilities are clearer, for example:

- lifecycle/state transitions
- read-model hydration
- taxonomy linking
- ordered-child mutations
- bundle business logic
- digital entitlement logic

This does not require over-architecting. It simply means putting each concern in one home.

---

## 12) The repo is cleaner, but not fully legacy-free yet

The active runtime path looks much cleaner now.

However, the repository still appears to carry rollout-history artifacts and documentation such as:

- `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md`
- `rollout-evidence/*`
- staged-rollout checklist language

### Why this matters

Because the package appears to publish only `src`, this is not a runtime blocker.

But if the stated goal is “legacy-code free,” then the repo itself is not fully there yet.

### Recommendation

After runtime cleanup is complete, do a repo-hygiene pass:

- archive or remove rollout-era docs that are no longer useful
- keep one canonical implementation posture
- reduce historical noise in the package root

---

## Recommended Next Steps (Priority Order)

## 1) Lock down the public read surface

Before deployment:

- make public product routes storefront-safe
- remove raw SKU exposure from public routes
- remove inventory version exposure from public routes
- prevent hidden/draft/archived leakage
- avoid exposing admin-grade entitlement detail publicly

## 2) Separate storefront reads from admin reads

Create clear boundaries:

- storefront DTOs
- admin DTOs
- storefront handlers
- admin handlers

This is the highest-value structural improvement remaining.

## 3) Fix the fake split

Choose one:

- truly split `catalog.ts`, or
- remove the shim files until you are ready

Do not keep architectural theater in the codebase.

## 4) Centralize lifecycle/state transitions

Unify product state logic in one place so handlers cannot drift.

## 5) Make full-read helpers pagination-safe

Introduce one shared complete-query helper and remove inconsistent assumptions.

## 6) Make ordered-child mutation flows safer

Prefer one authoritative mutation helper with explicit guarantees.

---

## Bottom Line

This branch is **substantially better** than the earlier one.

But it is **not yet where I would want it** if the goal is to be:

- storefront-safe
- DRY
- YAGNI
- genuinely legacy-clean

The biggest remaining problem is no longer webhook/finalize legacy logic.

It is now the **design of the public catalog read surface** and the **lack of strong separation between storefront and admin representations**.

If that is fixed well, the plugin will be in a much healthier position for first deployment and real testing.
