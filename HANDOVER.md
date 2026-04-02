# HANDOVER

## Goal

This repository is an EmDash-based effort to design and build a **native commerce plugin** that avoids WooCommerce-style theme coupling, global hook mutation, and plugin sprawl. The current goal is **not** to ship a broad storefront feature set. The current goal is to implement and validate the **next execution phase**: a storage-backed commerce kernel and the first **Stripe** end-to-end purchase slice with correct order finalization, inventory mutation, idempotency, and replay handling.

The commerce design assumes EmDash’s actual platform constraints: native plugins are required for rich React admin, Astro storefront components, and Portable Text blocks; standard/sandboxed plugins remain the right shape for narrower third-party providers. The architecture is intentionally **kernel-first** and **correctness-first**. The active design decision is to prefer **payment-first inventory finalization** and one **authoritative finalize path** rather than WooCommerce-style stock reservation in cart/session.

## New developer onboarding (start here)

If you are new to this repository, this file is the only required starting point:

1. Read this handover completely.
2. Review kernel entry points in `packages/plugins/commerce/src/kernel`.
3. Execute only the "Immediate next-step target" phase order below.

Optional context (for orientation only):

- `commerce-plugin-architecture.md`
- `3rdpary_review_3.md`
- `emdash-commerce-final-review-plan.md`
- `emdash-commerce-deep-evaluation.md`

## Onboarding mindset

Goal for the next engineer is not completeness, it is a repeatable, correct Stripe slice:

- storage-backed idempotent finalize orchestration first,
- webhook replay/conflict correctness before extra features,
- route contracts before integrations.

## One-document rule for this stage

For stage-1 execution, `HANDOVER.md` is the only document you must follow to
start coding. Use other documents for historical context after implementation begins.

## Completed work and outcomes

The architecture has been documented in depth in `commerce-plugin-architecture.md` for reference. This handover now drives the execution sequence for stage-1.

Several review rounds have already happened and the important feedback has been integrated. `emdash-commerce-final-review-plan.md` tightened the project around a **small, correctness-first kernel** and a **single real payment slice** before broader scope. `emdash-commerce-deep-evaluation.md` added useful pressure on architecture-to-code consistency and feature-fit, especially around bundle complexity and variant swatches. Historical context is preserved in `high-level-plan.md`, `3rdpary_review.md`, `3rdpary_review_2.md`, and the latest external-review summary `3rdpary_review_3.md`.

There is now a `packages/plugins/commerce` package with a **stage-1 vertical slice**:
storage-backed checkout, Stripe-shaped webhook finalize orchestration, kernel tests,
and plugin wiring (`createPlugin()` / `definePlugin`). See package `src/` for handlers,
orchestration, and schemas.

Kernel and shared helpers still live under `src/kernel/` (`finalize-decision`, errors,
limits, idempotency, rate-limit window, `api-errors`, etc.).

**AI / vector / MCP readiness** (contracts and stub route, not a full MCP server):

- `packages/plugins/commerce/AI-EXTENSIBILITY.md` — operational rules: embeddings on
  catalog, stable IDs on line items, read-only recommendations, planned
  `@emdash-cms/plugin-commerce-mcp`.
- `src/catalog-extensibility.ts` — `CommerceCatalogProductSearchFields` and reserved
  extension hook name constants.
- `recommendations` route — public POST stub (`strategy: "stub"`) for future vector or
  external recommender integration; must not mutate carts or orders.

Tests were run successfully from `packages/plugins/commerce` using:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
```

The repository also contains `commerce-vs-x402-merchants.md`, which is a one-page positioning aid explaining that Commerce and x402 are complementary rather than competing.

## Failures, open issues, and lessons learned

The architecture still runs ahead of **storefront UI, Stripe live wiring, and MCP**.
The commerce package **does** include plugin wiring, storage config, `checkout` and
`webhooks/stripe` routes, and finalize orchestration with tests. Treat anything beyond
that slice (bundles, shipping, rich admin, **commerce MCP tools**) as **future work**
unless explicitly scoped.

Resolved / encoded in code:

1. **Internal vs wire error codes:** Kernel uses **UPPER_SNAKE** keys on `COMMERCE_ERRORS`. Public APIs must emit **snake_case** via `COMMERCE_ERROR_WIRE_CODES` / `commerceErrorCodeToWire()` in `packages/plugins/commerce/src/kernel/errors.ts`. Route handlers own serialization and should use `toCommerceApiError()` from `packages/plugins/commerce/src/kernel/api-errors.ts`.
2. **Route-level API contract:** The API payload contract is centralized in `src/kernel/api-errors.ts`; it returns wire-safe codes and includes retry metadata from canonical metadata.
3. **Rate limit semantics:** The helper is **fixed-window**; docs and tests match. If sliding-window is required later, change the implementation deliberately.
4. **Rate-limit guardrail:** Invalid limiter inputs now fail closed (`allowed: false`) instead of silently disabling protection.

Third-party review (2026): next high-value work is **storage-backed orchestration** (orders, payment attempts, webhook receipts with uniqueness, inventory version/ledger, idempotent finalize, Stripe webhook integration tests)—not further kernel-only polish unless it unblocks that slice.

The next technical risk is not UI. It is the **storage mutation choreography**: proving that EmDash storage can enforce the planned invariants cleanly. The first serious implementation milestone should therefore be a storage-backed path for:

- order creation
- payment attempt persistence
- webhook receipt dedupe
- inventory version check
- ledger write + stock update
- idempotent finalize completion
- `payment_conflict` handling

Lesson learned from external reviews: do **not** broaden scope until the first Stripe flow survives duplicate webhooks, stale carts, and inventory-change conflicts. **MCP and LLM surfaces** may add **read-only contracts and documentation** early (see `AI-EXTENSIBILITY.md`); avoid **mutating** or **shortcutting** finalize/checkout via agents until the core path is proven.

## Files changed, key insights, and gotchas

For this stage, the most important file is this `HANDOVER.md`.

`commerce-plugin-architecture.md` is supporting architecture context and should be consulted only after the stage handoff flow is set.

`3rdpary_review.md` and earlier review artifacts are historical context.
`3rdpary_review_3.md`, `emdash-commerce-final-review-plan.md`, and `emdash-commerce-deep-evaluation.md` are optional review context only.

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

## Optional reference files and code context

### Reference context (not required to start)

- `commerce-plugin-architecture.md` — authoritative architecture and phased plan
- `HANDOVER.md` — this handoff
- `emdash-commerce-deep-evaluation.md` — latest deep evaluation, useful critique and feature-fit analysis
- `3rdpary_review_2.md`, `3rdpary_review_3.md` — third-party review packets
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

1. Add explicit storage schema and transactional persistence for:
   - `orders`
   - `cart` state
   - `payment_attempts`
   - `webhook_receipts` (unique constraint strategy)
   - `idempotency_keys`
   - `inventory_ledger`
2. Add `checkout` route and webhook route with a shared contract adapter (`toCommerceApiError()`).
3. Implement idempotent finalize orchestration, including receipt replay detection.
4. Add replay/conflict tests that prove:
   - duplicate webhook handling is deterministic,
   - `processed` vs `duplicate` receipt semantics remain explicit in storage/orchestration,
   - stale/invalid states return structured NOOP/RETRY outcomes,
   - no inventory mutation occurs when finalization is denied.
5. Implement Stripe adapter and wire it into finalize orchestration.
6. Ship minimal admin order visibility only after slice repeatability and replay safety are proven.

### Execution acceptance criteria (required to move past this stage)

- Checkout/webhook flows are backed by durable storage and idempotent keys.
- Finalize orchestration is deterministic for duplicate/replay deliveries.
- No inventory movement occurs unless finalize action succeeds.
- Finalization is blocked by explicit receipt/order state checks and emits canonical API error payloads.
- Tests cover duplicate, pending, and failed receipt pathways.

Do not expand to bundles, shipping/tax, or advanced storefront UI until that slice is correct and repeatable. **Read-only AI contracts** (stub `recommendations`, catalog embedding boundaries) are documented in `AI-EXTENSIBILITY.md`; **agent-driven mutations** and a full **commerce MCP** package remain out of scope until finalize replay safety is production-grade.

## Quality constraints for next developer

- Keep kernel pure and effect-free; routing and persistence belong in orchestration layers.
- Use `toCommerceApiError()` for every public error payload in route handlers.
- Preserve explicit state transitions; avoid broad enums for unresolved future use cases.
- Do not weaken `decidePaymentFinalize()` behavior without adding tests.
- Treat config as untrusted input in rate-limit/idempotency boundaries and fail safely.
