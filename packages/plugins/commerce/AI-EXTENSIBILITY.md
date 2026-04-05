# Commerce plugin — AI, vectors, and MCP readiness

This document aligns the **stage-1 commerce kernel** with future **LLM**, **vector search**, and **MCP** work. It is the operational companion to `COMMERCE_EXTENSION_SURFACE.md`.

## Vectors and catalog

- **Embeddings target catalog**, not transactional commerce storage. Product copy, `shortDescription`, and searchable facets live on **content / catalog documents** (or a future core vector index).
- **Orders and carts** keep **stable `productId` / `variantId`** and numeric snapshots (`unitPriceMinor`, `quantity`, `inventoryVersion`). Do not store duplicate canonical product text on line items for embedding purposes.
- Type-level contract for optional catalog fields: `CommerceCatalogProductSearchFields` in `src/catalog-extensibility.ts`.

## Checkout and agents

- **Checkout, webhooks, and finalize** remain **deterministic** and **mutation-authoritative**. Agents must not replace those flows with fuzzy reasoning.
- **Recommendation** and **search** are **read-only** surfaces. The `recommendations` plugin route is currently **disabled** (`strategy: "disabled"`, `reason: "no_recommender_configured"`) until vector search or an external recommender is wired; storefronts should hide the block when `enabled` is false.

Implementation guardrails:

- `src/index.ts` route table is the source of truth for shipped HTTP capabilities.
- `COMMERCE_EXTENSION_SURFACE.md` tracks stable extension seams and kernel closure rules.
- `src/catalog-extensibility.ts` defines export-level contracts for third-party providers.
- `commerce-extension-seams` helpers (`createRecommendationsRoute`,
  `createPaymentWebhookRoute`, `queryFinalizationState`) are the only MCP-facing
  extension surfaces for this stage.

## Current hardening status (next-pass gate)

- This branch ships regression-only updates for 5A (same-event duplicate webhook
   finalization convergence), 5B (pending-state contract visibility and non-terminal
   resume transitions), 5C (possession checks on order/cart entrypoints),
   5D (scope lock reaffirmation), 5E (deterministic claim lease policy), and
   5F (rollout docs/proof plan for strict lease mode).
- Post-5F optional AI roadmap items are tracked in `COMMERCE_AI_ROADMAP.md` and remain
  non-blocking to Stage-1 money-path behavior.
- Runtime behavior for checkout/finalize/routing remains unchanged while we continue
  to enforce the same scope lock for provider topology (`webhooks/stripe` only) until
  staged rollout approval for strict claim-lease mode (`COMMERCE_USE_LEASED_FINALIZE=1`).

### Strategy A acceptance guidance (contract hardening only)

**Strategy A metadata**

- Last updated: 2026-04-03
- Owner: emDash Commerce/AI integration owner
- Scope owner: contract hardening only (no AI/MCP command expansion)

- This stage is intentionally limited to **contract hardening**: keep all payment path runtime semantics unchanged.
- Contract consolidation and shape consistency are owned in `src/services/commerce-provider-contracts.ts` with matching tests in `src/services/commerce-provider-contracts.test.ts`.
- No provider registry routing, provider switching UI, or MCP command surface is introduced yet.
- Runtime gateway path remains `webhooks/stripe` until a second provider is actively enabled.
- Defer broader AI/MCP command expansions until:
  - the provider ecosystem reaches a second active payment adapter, and
  - a scoped commerce MCP command package is deployed.

## Errors and observability

- Public errors should continue to expose **machine-readable `code`** values (see kernel `COMMERCE_ERROR_WIRE_CODES` and `toCommerceApiError()`). LLMs and MCP tools should branch on `code`, not on free-form `message` text.
- Future `orderEvents`-style logs should record an **`actor`** (`system` | `merchant` | `agent` | `customer`) for audit trails; see `COMMERCE_EXTENSION_SURFACE.md`.
- For this stage, replay diagnostics should consume the enriched `queryFinalizationStatus`
  state shape (`receiptStatus` + `resumeState`) rather than inspecting storage manually.

### Stage-1 limits and Stage-2 roadmap

This stage intentionally excludes adjustment-event lifecycle automation:

- one active payment provider (`stripe`) through `webhooks/stripe`;
- no automatic refund/chargeback event replay for inventory restoration;
- no stage-2 “admin finalize transition” command surface;
- storefronts receive read-only finalization visibility only (`queryFinalizationState`).

Out-of-band stage-2 work should introduce provider-independent event adapter hooks
for credits/adjustments and define an explicit recovery tool path with audit controls.

## MCP

- **EmDash MCP** today targets **content** tooling. A dedicated **`@emdash-cms/plugin-commerce-mcp`** package is **planned** (`COMMERCE_EXTENSION_SURFACE.md`) for scoped tools: product read/write, order lookup for customer service (prefer **short-lived tokens** over wide-open order id guessing), refunds, etc.
- MCP tools must respect the same invariants as HTTP routes: **no bypass** of finalize/idempotency rules for payments.
- MCP tools should be read/write-safe by design: reads use `queryFinalizationStatus`/order APIs, writes use service seams that enforce kernel checks.

## Related files

| Item                                     | Location                              |
| ---------------------------------------- | ------------------------------------- |
| Disabled recommendations route           | `src/handlers/recommendations.ts`     |
| Catalog/search field contract            | `src/catalog-extensibility.ts`        |
| Extension seams and invariants           | `COMMERCE_EXTENSION_SURFACE.md`       |
| Architecture (MCP tool list, principles) | `COMMERCE_EXTENSION_SURFACE.md` |
| Execution handoff                        | `HANDOVER.md`                         |
