# EmDash Commerce Review Update — Ordered Child Mutation Refactor Progress

## Summary

This stage is a good step.

It directly addresses the next refactor pressure point from the prior review: **ordered child mutation logic is now more deliberate, more shared, and less fragile**.

## What Improved

### 1) Ordered-row logic is materially cleaner

The new helpers are a real win:

- `normalizeOrderedPosition`
- `normalizeOrderedChildren`
- `addOrderedRow`
- `removeOrderedRow`
- `moveOrderedRow`
- `persistOrderedRows`

This is the right abstraction level. It removes repeated hand-written position math from multiple handlers without introducing a large new framework.

This is the kind of refactor that pays for itself:

- local
- validated
- low-risk
- clearly useful

### 2) Bundle ordering is now deterministic

This is the most important part of this stage.

Bundle components are now sorted by:

- `position`
- then `createdAt` as a tiebreaker

and positions are normalized before persistence.

That matters because earlier reorder/remove behavior could become unstable if storage returned equal-position rows in inconsistent order. This update closes that gap in a grounded, practical way.

### 3) Asset and bundle paths now follow the same pattern

This is a meaningful DRY improvement.

The asset-link and bundle-component handlers now both follow the same shape:

1. load rows
2. apply ordered-row mutation
3. normalize
4. persist

That reduces cognitive load and lowers the chance that one path quietly drifts from the other.

## Why This Is a Strong Refactor

From a pragmatic engineering perspective, this is a good example of fixing what is actually costing the codebase.

It improves:

- **Cognitive load:** less repeated position logic
- **Correctness:** more deterministic reorder/remove behavior
- **DRY:** clearly better
- **YAGNI:** still disciplined, not speculative
- **Scalability:** modestly better because future ordered-child features now have a reusable pattern

Importantly, it does **not** disturb the kernel or broaden scope.

## What Was Validated

These are the specific signs that this is not just stylistic cleanup:

- a deterministic sort helper for bundle components was added
- bundle queries now normalize ordering before downstream use
- reorder/remove/create handlers for assets and bundles now share the same ordered-row mutation model
- tests cover:
  - asset reordering
  - bundle component reordering
  - bundle component removal with position normalization

That is enough evidence to say this change is supported by real code and tests, not just preference.

## Minor Caveat

There is one small note:

`normalizeBundleComponentPositions(...)` now conceptually overlaps with `normalizeOrderedChildren(...)`.

This is not a bug. But it is a small sign that the ordered-row abstraction is **almost** fully consolidated, not quite fully consolidated.

This is not worth changing right now unless that area is already being touched again.

## Recommendation

**Accept this stage.**

This is a practical refactor with good judgment:

- it fixes a real stability issue
- it reduces duplication
- it stays disciplined

## Current Overall State

Compared with the earlier reviews, the codebase now looks materially healthier:

- inventory consistency improved
- simple-product SKU capacity is guarded
- ordered-child mutation logic is cleaner and more deterministic

The remaining concerns are no longer correctness-fire issues. They are more typical foundational-project concerns:

- `catalog.ts` still carries a lot of responsibility
- read assembly is still somewhat heavy
- partial-write and transactional integrity are still only partially hardened

None of those look like mandatory next-stage fixes unless new evidence shows they are causing trouble.

## Bottom Line

This stage is a good, appropriately scoped improvement. It strengthens correctness, reduces duplication, and keeps the project aligned with a disciplined, non-overengineered path.
