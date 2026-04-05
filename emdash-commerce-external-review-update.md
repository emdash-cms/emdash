# EmDash Commerce External Review Update

## Review scope

This memo reflects a review of the current iteration contained in:

- `emDash-review-for-external-review.zip`

It is an update to the prior external-review posture, focused on the latest state of the catalog implementation and its integration with the existing commerce kernel.

---

## Executive summary

This is a **stronger iteration** than the prior version.

The catalog layer now has real substance:

- immutable-field rules are in place,
- variable-product invariants are materially better,
- shared domain helpers are cleaner,
- snapshot logic is better separated from handler code.

The main remaining issue is this:

> **Bundles appear to be more complete as a catalog concept than as a transactional commerce concept.**

In other words, bundle creation, storage, pricing, and derived availability are advancing well, but checkout/finalization still appears too dependent on direct line-item inventory records rather than derived component inventory behavior.

That is the most important thing that calls for an updated review.

---

## Overall verdict

**Current state: good, with meaningful architectural improvement.**

I do **not** see new architectural chaos or obvious structural regression.

The codebase is improving in the right ways:

- less sloppy mutation behavior,
- better domain separation,
- stronger invariant enforcement,
- better groundwork for product snapshots and future catalog growth.

But I would **not** yet describe the bundle implementation as fully end-to-end complete.

---

## What improved materially

### 1. Handler coupling is better

Earlier concern around handler-to-handler coupling appears improved.

The code now uses shared domain helpers such as:

- `lib/catalog-domain.ts`
- `lib/catalog-variants.ts`
- `lib/catalog-bundles.ts`
- `lib/catalog-order-snapshots.ts`

This is the right direction.

It keeps handlers thinner and reduces the risk of circular or muddled handler responsibilities.

### 2. Immutable-field discipline is now present

This is a meaningful improvement.

The current catalog-domain layer protects important immutable fields such as:

- product `id`
- product `type`
- product `createdAt`
- SKU `id`
- SKU `productId`
- SKU `createdAt`

That is much safer than loose merge-on-write behavior and better matches a commerce-grade data model.

### 3. Variable-product invariants are reasonably solid

This part now looks genuinely decent.

The variable-product validation logic appears to enforce:

- exact option count,
- only variant-defining attributes,
- no duplicate attribute assignment,
- no missing attribute values,
- no duplicate variant combinations.

That is one of the strongest areas of the current implementation.

### 4. Snapshot logic was extracted into a better place

This is also a good improvement.

Moving snapshot assembly into a shared helper such as `lib/catalog-order-snapshots.ts` is the correct design move. It keeps checkout code narrower and makes the historical-order strategy more explicit and maintainable.

---

## Main issue requiring updated review

## Bundles appear catalog-complete before they are transaction-complete

This is the biggest issue in the current iteration.

The code now appears to support bundle catalog behavior reasonably well:

- bundle entities exist,
- bundle component management exists,
- derived pricing exists,
- derived availability exists.

That is all good.

However, checkout/finalization still appears to validate stock in a way that assumes a direct inventory row for each line item. If bundle products do **not** own independent inventory, then the transaction path must not require bundle-owned stock rows.

### Why this matters

Your own stated model is:

- bundles do **not** have independent inventory,
- bundle availability is derived from component SKUs,
- successful purchase of a bundle should decrement component inventory, not bundle inventory.

If checkout is still trying to validate line-item inventory directly against a bundle row, then one of two things is true:

1. bundle purchases will fail incorrectly, or
2. fake bundle inventory rows are being used, which would violate the intended model.

Either way, the model is not fully closed yet.

### What should happen next

Before bundle support is considered fully complete, the transaction core should explicitly support bundle lines by doing all of the following:

- recognize bundle products in cart/checkout,
- validate stock against component SKUs,
- decrement component inventory on successful finalize,
- avoid requiring bundle-owned inventory rows.

This is the main gap I would want fixed next.

---

## Secondary concerns

### 1. Update flows appear a little too dependent on storage-layer uniqueness

This is not a deep flaw, but it is still worth tightening.

Examples of what should be validated explicitly at the domain layer:

- slug uniqueness on product update,
- SKU code uniqueness on SKU update,
- bundle discount field validity only for bundle products.

Storage-level uniqueness is useful, but domain-level validation gives better correctness and much better admin/operator errors.

### 2. Current SKU model still looks narrower than the full spec

The current implementation appears staged, which is fine. But it still looks thinner than the full target schema in several areas.

Examples that may still be missing or only partially implemented:

- inventory mode (`tracked` vs `not_tracked`)
- backorder flag
- weight and dimensions
- tax class at SKU level
- archived SKU status beyond `active | inactive`

That does **not** make the work bad. It just means this is best described as a **good staged implementation**, not yet full schema parity with the broader v1 catalog specification.

### 3. Snapshot representation is ahead of some underlying bundle operations

The snapshot system is structurally good.

But because bundle stock and finalize semantics do not yet appear fully integrated, bundle snapshot handling currently looks stronger than the underlying transactional behavior for that same product type.

That is a sequencing issue, not a design collapse, but it is still worth calling out.

---

## Smaller notes

These are smaller observations, but still useful:

- asset unlink/reorder behavior should keep sibling positions normalized,
- low-stock logic should not simply mean `inventoryQuantity <= 0` if the intent is truly “low stock,”
- bundle discount fields should be constrained clearly to bundle products,
- read-style operations using post-style handler semantics are acceptable internally, but still a little awkward if judged as public API design.

---

## Updated practical verdict

The current codebase is stronger than the previous iteration.

I would describe it this way:

**The catalog architecture is now materially more credible. Immutable-field rules, variable-option invariants, shared domain helpers, and extracted order snapshot logic all improve the structure of the system.**

But I would also say:

**The bundle model still appears only partially integrated into the transaction core. Catalog support is ahead of checkout/finalization support, because bundle availability and stock ownership are derived from component SKUs while the transaction path still appears too dependent on direct line-item inventory rows.**

That is the main outstanding concern.

---

## Recommended next step

The next priority should be:

## Make bundles transaction-complete

Specifically:

1. teach checkout/cart validation how to handle bundle lines using component SKU stock,
2. teach finalization how to decrement bundle component inventory,
3. ensure no bundle-owned stock rows are required,
4. add integration tests for bundle purchase success/failure paths.

Once that is done, the catalog work will feel much more end-to-end complete.

---

## Bottom line

**Current state: good, but not fully closed.**

I do not see new architectural red flags.

The most important update to the external review is:

> **Bundles are implemented faster as a catalog concept than as a transactional commerce concept.**

That is the main gap I would fix next.
