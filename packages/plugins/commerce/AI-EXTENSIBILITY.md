# Commerce plugin — AI, vectors, and MCP readiness

This document aligns the **stage-1 commerce kernel** with future **LLM**, **vector search**, and **MCP** work. It is the operational companion to Section 11 in `commerce-plugin-architecture.md`.

## Vectors and catalog

- **Embeddings target catalog**, not transactional commerce storage. Product copy, `shortDescription`, and searchable facets live on **content / catalog documents** (or a future core vector index).
- **Orders and carts** keep **stable `productId` / `variantId`** and numeric snapshots (`unitPriceMinor`, `quantity`, `inventoryVersion`). Do not store duplicate canonical product text on line items for embedding purposes.
- Type-level contract for optional catalog fields: `CommerceCatalogProductSearchFields` in `src/catalog-extensibility.ts`.

## Checkout and agents

- **Checkout, webhooks, and finalize** remain **deterministic** and **mutation-authoritative**. Agents must not replace those flows with fuzzy reasoning.
- **Recommendation** and **search** are **read-only** surfaces. The `recommendations` plugin route is currently **disabled** (`strategy: "disabled"`, `reason: "no_recommender_configured"`) until vector search or an external recommender is wired; storefronts should hide the block when `enabled` is false.

## Errors and observability

- Public errors should continue to expose **machine-readable `code`** values (see kernel `COMMERCE_ERROR_WIRE_CODES` and `toCommerceApiError()`). LLMs and MCP tools should branch on `code`, not on free-form `message` text.
- Future `orderEvents`-style logs should record an **`actor`** (`system` | `merchant` | `agent` | `customer`) for audit trails; see architecture Section 11.

## MCP

- **EmDash MCP** today targets **content** tooling. A dedicated **`@emdash-cms/plugin-commerce-mcp`** package is **planned** (architecture Section 11) for scoped tools: product read/write, order lookup for customer service (prefer **short-lived tokens** over wide-open order id guessing), refunds, etc.
- MCP tools must respect the same invariants as HTTP routes: **no bypass** of finalize/idempotency rules for payments.

## Related files

| Item | Location |
|------|----------|
| Disabled recommendations route | `src/handlers/recommendations.ts` |
| Catalog/search field contract | `src/catalog-extensibility.ts` |
| Architecture (MCP tool list, principles) | `commerce-plugin-architecture.md` §11 |
| Execution handoff | `HANDOVER.md` |
