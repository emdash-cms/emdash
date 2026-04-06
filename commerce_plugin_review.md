# EmDash Commerce Plugin Review

Date: 2026-04-06  
Scope reviewed: `packages/plugins/commerce` from `COMMERCE_REVIEW_HANDOFF_PLAN_5F.zip`

## Executive summary

This codebase is in better shape than many first-pass ecommerce plugins. The architecture is mostly coherent, storage/index definitions are thoughtful, test coverage appears broad, and the checkout/finalize path shows real discipline.

That said, I would **not deploy this plugin yet**.

The most important blocker is simple: **the catalog/admin mutation surface is exposed as public routes**. For a greenfield plugin that has not shipped, there is no good reason to leave privileged catalog writes publicly accessible.

The second major issue is that the code still carries **real compatibility and rollout branches** in runtime paths. Because this plugin has not yet been deployed, those branches should now be removed rather than preserved.

I could not run the automated tests in this container because `pnpm` is not installed here, so this is a **thorough static review**, not an execution-validated test run.

---

## Overall assessment

**Strengths**

- Kernel-first direction is sensible.
- Storage declarations and uniqueness/index coverage are stronger than average.
- Catalog domain modeling is reasonably clean.
- The codebase shows evidence of tests and design discipline rather than ad hoc implementation.

**Main risks before deployment**

1. Access control and route exposure
2. Runtime compatibility/legacy branches that should not exist in a never-deployed release
3. A catalog handler that is becoming too large to trust easily
4. Read/query patterns that will not age well under catalog growth
5. Write-path race handling that is still friendlier than it is robust

---

## Severity-ranked findings

## Critical

### 1) Privileged catalog and admin write routes are public

**Why this matters**

The route registry exposes nearly the entire catalog mutation surface as `public: true`, including product creation, updates, SKU writes, category/tag writes, asset linking, bundle writes, and digital entitlement writes.

**Evidence**

`src/index.ts:201-370`

Notable examples:

- `product-assets/register` — `src/index.ts:212-216`
- `catalog/product/create` — `src/index.ts:267-271`
- `catalog/product/update` — `src/index.ts:277-280`
- `catalog/category/create` — `src/index.ts:287-290`
- `catalog/tag/create` — `src/index.ts:307-310`
- `catalog/sku/create` — `src/index.ts:332-335`
- `digital-entitlements/create` — `src/index.ts:257-260`

Inside `src/handlers/catalog.ts`, the mutation handlers are POST-gated with `requirePost(ctx)`, but I found no corresponding authorization enforcement in this package. The repeated calls to `requirePost(ctx)` begin at `src/handlers/catalog.ts:688` and continue through the rest of the file.

**Risk**

If EmDash does not inject strong auth outside this plugin, unauthenticated or low-trust callers could mutate the catalog.

**Recommendation**

- Default all catalog/admin mutation routes to non-public.
- Keep only clearly storefront-safe routes public.
- Add one explicit `require_admin_access()`-style helper and call it in every privileged mutation and privileged read.
- Treat digital entitlement creation/removal as privileged operations.

**Suggested public set**

Likely public:

- `cart/upsert`
- `cart/get`
- `checkout`
- `checkout/get-order` (token-gated possession proof already exists)
- `recommendations`
- `webhooks/stripe`

Everything else should start private unless there is a very strong reason otherwise.

---

## High

### 2) Legacy webhook compatibility mode is still in the production schema

**Why this matters**

The Stripe webhook schema still accepts a legacy direct body shape instead of only accepting the verified webhook event structure.

**Evidence**

`src/schemas.ts:162-191`

Specifically:

- legacy input object at `src/schemas.ts:162-171`
- union that keeps both modes alive at `src/schemas.ts:184-188`
- inline comment explicitly says this supports an old integration and some tests at `src/schemas.ts:185`

**Risk**

- Wider ingress contract than needed
- Larger test matrix
- Old assumptions preserved in production runtime
- Higher chance of accidental misuse by integrators

**Recommendation**

- Remove the legacy schema from runtime code.
- Accept only the verified Stripe event shape in production.
- Move any shortcut test payloads into test helpers or fixtures.

---

### 3) Checkout replay validation still tolerates legacy cache rows

**Why this matters**

Completed checkout replay validation still permits cached responses without `replayIntegrity`.

**Evidence**

`src/handlers/checkout-state.ts:133-153`

The comment at `src/handlers/checkout-state.ts:135` explicitly states the missing-integrity case is treated as a legacy cache path.

**Risk**

A greenfield release should not ship with relaxed replay validation for pre-existing cache formats that should not exist.

**Recommendation**

- Require `replayIntegrity` on completed cached responses.
- Remove the legacy acceptance branch.
- If migration support is needed for tests, keep it in fixtures, not runtime behavior.

---

### 4) Bundle finalization still supports a legacy stock fallback path

**Why this matters**

Bundle inventory deduction only expands bundle components when every component has a non-negative `componentInventoryVersion`. Otherwise it falls back to treating the line as a legacy bundle row keyed by the bundle product.

**Evidence**

- `src/lib/order-inventory-lines.ts:1-48`
- `src/types.ts:80-84`

The docs/comments are explicit:

- `src/lib/order-inventory-lines.ts:8` says the line is treated like a legacy bundle row
- `src/types.ts:82` says finalization falls back to legacy bundle-line stock rows

There is also a dedicated test covering the legacy path:

- `src/orchestration/finalize-payment-inventory.test.ts:121-122`

**Risk**

This is the sort of compatibility behavior that quietly survives forever and later becomes a source of stock inconsistencies.

**Recommendation**

- Remove the legacy fallback for first release.
- Fail fast if a bundle snapshot lacks valid component inventory versions.
- Treat missing component versions as a checkout snapshot bug, not something to silently absorb.

---

### 5) Finalization behavior is still split by environment toggles

**Why this matters**

The finalize path still depends on environment flags for behavior selection.

**Evidence**

`src/orchestration/finalize-payment.ts:84-86`

- `COMMERCE_ENABLE_FINALIZE_INVARIANT_CHECKS`
- `COMMERCE_USE_LEASED_FINALIZE`

Package-level docs also confirm this staged rollout posture:

- `packages/plugins/commerce/COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md`
- `packages/plugins/commerce/rollout-evidence/*`
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`

**Risk**

For a not-yet-deployed plugin, rollout toggles preserve unnecessary alternate runtime paths and make the release posture ambiguous.

**Recommendation**

- Pick the canonical finalize path now.
- Delete the alternate runtime mode before first deployment.
- Keep invariants on by default unless there is a very strong measured reason not to.

---

## Medium

### 6) `catalog.ts` is now too large and multi-purpose

**Why this matters**

`src/handlers/catalog.ts` is 1,924 lines and now spans too many concerns.

**Evidence**

- file length: `src/handlers/catalog.ts` = 1,924 lines

It covers:

- product CRUD/state
- SKU CRUD/state/listing
- categories and tags
- category/tag links
- assets and asset ordering
- bundle components
- digital assets and entitlements
- read-model hydration

**Risk**

- Harder code review
- Higher regression risk
- More difficult onboarding
- Greater chance of hidden coupling

**Recommendation**

Split by domain boundary now, before more features land:

- `catalog-products.ts`
- `catalog-skus.ts`
- `catalog-taxonomy.ts`
- `catalog-assets.ts`
- `catalog-bundles.ts`
- `catalog-digital.ts`
- shared `catalog-read-model.ts`

This is a maintainability refactor, not an architectural rewrite.

---

### 7) Product listing fetches broadly, then filters and slices in memory

**Why this matters**

The product list handler pulls a base result set, then applies category/tag filtering in memory, sorts in memory, and slices to the requested limit afterward.

**Evidence**

`src/handlers/catalog.ts:1008-1028`

Key lines:

- broad query: `src/handlers/catalog.ts:1008-1010`
- category filter in memory: `src/handlers/catalog.ts:1013-1017`
- tag filter in memory: `src/handlers/catalog.ts:1019-1023`
- sort and slice after full filtering: `src/handlers/catalog.ts:1025-1028`

**Risk**

This is acceptable for a tiny catalog. It becomes less attractive as the catalog grows, especially if product media and metadata hydration remain downstream of that query.

**Recommendation**

- Push more filtering into indexed queries.
- When category or tag filters are present, query link tables first and drive product lookup from those IDs.
- Add cursor/pagination semantics now, before API consumers depend on whole-list behavior.

---

### 8) Uniqueness checks are friendly, but race-prone

**Why this matters**

Create paths perform preflight query checks before writes. That is helpful for nicer error messages, but it is not sufficient under concurrency.

**Evidence**

- product slug precheck: `src/handlers/catalog.ts:711-717`
- category slug precheck: `src/handlers/catalog.ts:1075-1080`
- tag slug precheck: `src/handlers/catalog.ts:1183-1188`
- SKU code precheck: `src/handlers/catalog.ts:1287-1292`

Storage does define proper unique indexes:

- products slug: `src/storage.ts:10`
- categories slug: `src/storage.ts:34`
- tags slug: `src/storage.ts:42`
- SKU code: `src/storage.ts:70`

**Risk**

Two concurrent writers can both pass the query check, then race into the write.

**Recommendation**

- Keep the preflight checks if you want user-friendly messages.
- But also normalize storage-level unique constraint failures on `put`.
- Make the storage constraint the true source of truth.

---

### 9) Route registration is getting too manual

**Why this matters**

`src/index.ts` is doing route registry composition by hand for everything.

**Evidence**

`src/index.ts:201-370`

**Risk**

As the surface grows, this becomes a hotspot for accidental exposure, naming drift, and review fatigue.

**Recommendation**

Split route registration into grouped registries:

- storefront routes
- admin/catalog routes
- webhook routes
- optional extension routes

This change would also make access classification more obvious.

---

### 10) Package documentation still signals rollout-in-progress rather than first-release posture

**Why this matters**

The package root still includes rollout notes, evidence logs, and compatibility-oriented documentation that imply a staged migration rather than a clean first deployment.

**Evidence**

Examples:

- `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md`
- `rollout-evidence/legacy-test-output.md`
- `rollout-evidence/strict-test-output.md`
- `rollout-evidence/strict-finalize-smoke-output.md`

**Risk**

Not a direct runtime bug, but it confirms the release posture is still transitional.

**Recommendation**

- Decide what is canonical.
- Keep only the docs that reflect the intended release state.
- Archive or move rollout artifacts out of the plugin package if they are only historical.

---

## Lower-severity observations

### 11) Some public read routes may expose more internal catalog state than intended

This is a design concern rather than a proven bug.

Because product, category, tag, and SKU reads/lists are public, you should verify whether storefront callers are meant to see:

- draft products
- hidden products
- archived products
- inactive SKUs
- bundle composition details
- digital entitlement relationships

If the storefront is only meant to expose sellable catalog data, public reads should apply storefront-safe filters by default.

---

## What I did **not** find

I did **not** see obvious signs of random dead code sprawl or rushed copy-paste architecture. This is not a messy codebase. The issues are more about release posture, trust boundaries, and a few places where the implementation is still carrying migration-era assumptions.

---

## Recommended action plan

## Stop-ship before deployment

1. **Lock down route exposure**
   - Make catalog/admin mutation routes private.
   - Add explicit authorization checks.

2. **Remove greenfield-inappropriate compatibility paths**
   - delete legacy webhook schema branch
   - require replay integrity for completed checkout cache
   - remove legacy bundle stock fallback
   - choose one finalize mode and delete the other runtime path

3. **Audit public reads**
   - confirm what storefront callers are allowed to see
   - default to storefront-safe visibility/status filters

## Next refactor pass

4. **Split `catalog.ts` by concern**
5. **Push product filtering closer to indexed storage**
6. **Normalize unique-index write failures instead of relying only on prechecks**
7. **Split route registration into grouped modules**

---

## Suggested developer framing

If you want to give a developer a crisp mandate, this is the version I would use:

> Before first deployment, treat this plugin as greenfield. Remove all runtime compatibility branches that only exist to support old integrations or phased rollouts. Tighten route exposure so only storefront-safe endpoints are public. Then do one maintainability refactor to split the catalog handler and harden query/write paths.

---

## Bottom line

This plugin is **promising and fairly disciplined**, but it is **not yet in the cleanest first-release state**.

The two biggest corrections are:

- **fix route exposure / authorization**
- **remove legacy and rollout-era runtime branches**

Once those are addressed, the remaining work is mostly maintainability and scaling hygiene rather than foundational redesign.
