# HANDOVER

## Goal

This repository is an EmDash-based effort to design and build a **native commerce plugin** that avoids WooCommerce-style theme coupling, global hook mutation, and plugin sprawl. The current goal is **not** to ship a broad storefront feature set. The current goal is to implement and validate the **next execution phase**: a storage-backed commerce kernel and the first **Stripe** end-to-end purchase slice with correct order finalization, inventory mutation, idempotency, and replay handling.

The commerce design assumes EmDash’s actual platform constraints: native plugins are required for rich React admin, Astro storefront components, and Portable Text blocks; standard/sandboxed plugins remain the right shape for narrower third-party providers. The architecture is intentionally **kernel-first** and **correctness-first**. The active design decision is to prefer **payment-first inventory finalization** and one **authoritative finalize path** rather than WooCommerce-style stock reservation in cart/session.

## Completed work and outcomes

The architecture has been documented in depth in `commerce-plugin-architecture.md`. That document is now the **authoritative blueprint**. It includes the plugin model, product/cart/order data model, provider execution model, phased plan, state machines, storage schema, error catalog, cart merge rules, observability requirements, robustness/scalability rules, and platform-alignment notes for EmDash and Cloudflare Workers.

Several review rounds have already happened and the important feedback has been integrated. `emdash-commerce-final-review-plan.md` tightened the project around a **small, correctness-first kernel** and a **single real payment slice** before broader scope. `emdash-commerce-deep-evaluation.md` added useful pressure on architecture-to-code consistency and feature-fit, especially around bundle complexity and variant swatches. Historical context is preserved in `high-level-plan.md`, `3rdpary_review.md`, and the current external-review packet `3rdpary_review_2.md`.

There is now an initial `packages/plugins/commerce` package in-tree. It is **not** a working plugin yet. It is a small kernel scaffold with pure helpers and tests:

- `src/kernel/finalize-decision.ts` + test
- `src/kernel/errors.ts`
- `src/kernel/limits.ts`
- `src/kernel/idempotency-key.ts` + test
- `src/kernel/provider-policy.ts`
- `src/kernel/rate-limit-window.ts` + test

Tests were run successfully from `packages/plugins/commerce` using:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
```

The repository also contains `commerce-vs-x402-merchants.md`, which is a one-page positioning aid explaining that Commerce and x402 are complementary rather than competing.

## Failures, open issues, and lessons learned

The biggest current reality: **the architecture is ahead of the code**. The project has a strong design and a small tested kernel scaffold, but it does **not** yet have plugin wiring, storage adapters, checkout routes, Stripe integration, admin pages, or a working storefront checkout flow. Treat the current codebase as **pre-vertical-slice**.

There are two documentation-to-code mismatches already identified and preserved for the next developer:

1. The architecture wants **snake_case wire-level error codes**, but `packages/plugins/commerce/src/kernel/errors.ts` still uses **uppercase internal constant keys**. The architecture doc now states this explicitly. Before public route handlers ship, normalize the exported API error shape.
2. The architecture originally described **sliding-window** rate limiting, but the implemented helper is a **fixed-window** counter. The architecture doc has been corrected to match the code. If a true sliding-window algorithm is required later, change the code deliberately rather than drifting the docs again.

The next technical risk is not UI. It is the **storage mutation choreography**: proving that EmDash storage can enforce the planned invariants cleanly. The first serious implementation milestone should therefore be a storage-backed path for:

- order creation
- payment attempt persistence
- webhook receipt dedupe
- inventory version check
- ledger write + stock update
- idempotent finalize completion
- `payment_conflict` handling

Lesson learned from external reviews: do **not** broaden scope until the first Stripe flow survives duplicate webhooks, stale carts, and inventory-change conflicts. Do **not** introduce broad provider ecosystems, bundle complexity, MCP surfaces, or rich UI faster than the finalization path and tests.

## Files changed, key insights, and gotchas

The most important file is `commerce-plugin-architecture.md`. It supersedes `high-level-plan.md`. If there is a conflict between documents, **follow `commerce-plugin-architecture.md`** unless a newer handoff or review file explicitly says otherwise.

`3rdpary_review.md` is now marked as **historical**. `3rdpary_review_2.md` is the current external-review packet. `emdash-commerce-final-review-plan.md` and `emdash-commerce-deep-evaluation.md` are not authoritative specs, but they contain high-value critique that shaped the current plan and should be treated as review context, not ignored.

The architecture has already chosen some important product constraints:

- **Gateways**: Stripe first, then Authorize.net to validate auth/capture behavior.
- **Inventory**: payment-first finalize, not cart-time reservation.
- **Shipping/tax**: separate module family; not core v1.
- **Identity**: durable logged-in carts with guest-cart merge rules.

The main gotchas to avoid:

- Do not reintroduce **HTTP-first** internal delegation for first-party providers; use **in-process adapters** unless the sandbox boundary forces route delegation.
- Do not let `meta` or `typeData` turn into uncontrolled junk drawers. Core logic must not depend on loosely typed extension metadata.
- Do not put business logic in admin or storefront layers. Keep kernel code pure and keep `ctx.*` in the plugin wrapper.
- Do not treat x402 as a replacement for cart commerce. Use `commerce-vs-x402-merchants.md` if product confusion starts.
- Do not trust `CF-Worker`-style headers or user-provided URLs for authorization or routing. The platform-alignment section in `commerce-plugin-architecture.md` already calls out SSRF and binding constraints.

## Key files and directories

### Authoritative architecture and reviews

- `commerce-plugin-architecture.md` — authoritative architecture and phased plan
- `HANDOVER.md` — this handoff
- `emdash-commerce-final-review-plan.md` — review-driven refinement toward kernel-first execution
- `emdash-commerce-deep-evaluation.md` — latest deep evaluation, useful critique and feature-fit analysis
- `3rdpary_review_2.md` — current third-party review packet
- `3rdpary_review.md` — historical review packet
- `high-level-plan.md` — original short plan, retained for history
- `commerce-vs-x402-merchants.md` — merchant-facing positioning note

### Commerce package (current code)

- `packages/plugins/commerce/package.json`
- `packages/plugins/commerce/tsconfig.json`
- `packages/plugins/commerce/vitest.config.ts`
- `packages/plugins/commerce/src/kernel/`

### EmDash reference implementation

- `skills/creating-plugins/SKILL.md` — plugin model ground truth
- `packages/plugins/forms/src/index.ts`
- `packages/plugins/forms/src/storage.ts`
- `packages/plugins/forms/src/schemas.ts`
- `packages/plugins/forms/src/types.ts`
- `packages/plugins/forms/src/handlers/submit.ts`

### Immediate next-step target

Build the first **real** vertical slice in this order:

1. storage-backed order/cart/payment persistence
2. Stripe provider adapter
3. checkout route + webhook route
4. `finalizePayment` orchestration
5. replay/conflict tests
6. minimal admin order visibility

Do not expand to bundles, shipping/tax, advanced storefront UI, or MCP/AI operations until that slice is correct and repeatable.
