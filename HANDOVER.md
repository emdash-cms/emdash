# HANDOVER

## 1) Project status: purpose and current problem

This repository hosts an EmDash-native commerce plugin with a narrow stage-1 scope: deterministic checkout and webhook-driven payment finalization for Stripe using storage-backed state. The transaction core is hardened for partial failure, idempotent replay, and observable exit paths.

**Current product goal:** enable a **minimal end-to-end path**—product display (CMS/site) → **cart in plugin storage** → **checkout** → **webhook finalize**—without refactoring finalize/checkout internals. The next implementer adds **adjacent** cart routes and tests only; the money path stays locked per §6.

## 2) Completed work and outcomes

Stage-1 commerce lives in `packages/plugins/commerce` with Vitest coverage (currently **15 files / 71 tests** in that package).

- **Checkout** ([`src/handlers/checkout.ts`](packages/plugins/commerce/src/handlers/checkout.ts)): deterministic idempotency; recovers order/attempt from pending idempotency records; validates cart line items and stock preflight; requires `ownerToken` when the cart has `ownerTokenHash` (same as `cart/get` / `cart/upsert`).
- **Finalize** ([`src/orchestration/finalize-payment.ts`](packages/plugins/commerce/src/orchestration/finalize-payment.ts)): centralized orchestration; `queryFinalizationStatus(...)` for diagnostics; inventory reconcile when ledger wrote but stock did not; explicit logging on core paths; intentional bubble on final receipt→`processed` write (retry-safe).
- **Decisions** ([`src/kernel/finalize-decision.ts`](packages/plugins/commerce/src/kernel/finalize-decision.ts)): receipt semantics documented (`pending` = resumable; `error` = narrow terminal when order disappears mid-run).
- **Stripe webhook** ([`src/handlers/webhooks-stripe.ts`](packages/plugins/commerce/src/handlers/webhooks-stripe.ts)): signature verification; raw body byte cap before verify; rate limit.
- **Order read for SSR** ([`src/handlers/checkout-get-order.ts`](packages/plugins/commerce/src/handlers/checkout-get-order.ts)): `POST checkout/get-order` returns a public order snapshot; requires `finalizeToken` whenever the order has `finalizeTokenHash` (checkout always sets it). Rows without a hash are not returned (`ORDER_NOT_FOUND`).
- **Recommendations** ([`src/handlers/recommendations.ts`](packages/plugins/commerce/src/handlers/recommendations.ts)): returns `enabled: false` and stable `reason`—storefronts should hide the block until a recommender exists.

Operational docs: [`packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK.md`](packages/plugins/commerce/PAID_BUT_WRONG_STOCK_RUNBOOK.md), support variant alongside, [`COMMERCE_DOCS_INDEX.md`](packages/plugins/commerce/COMMERCE_DOCS_INDEX.md).

### Validate the plugin (from repo root)

```bash
pnpm install
cd packages/plugins/commerce
pnpm test
pnpm typecheck
```

Targeted checkout + finalize only:

```bash
cd packages/plugins/commerce
pnpm test -- src/handlers/checkout.test.ts src/orchestration/finalize-payment.test.ts
```

## 3) Failures, open issues, and lessons learned

- **Same-event concurrency:** two workers can still race before a durable claim is visible; storage does not expose a true insert-if-not-exists claim primitive—documented in finalize code; do not paper over with “optimistic” core changes without tests + platform support.
- **`pending` receipt:** not terminal; safe retry semantics are defined—see runbooks and kernel comments.
- **`error` receipt:** narrow terminal today (order vanished mid-finalize); do not auto-replay without an explicit recovery design.
- **`put()` is not a distributed lock.**

Lesson: expand features only after negative-path tests and incident semantics stay green.

## 4) Files, insights, and gotchas

### Primary references

| Area | Path |
|------|------|
| Checkout | `packages/plugins/commerce/src/handlers/checkout.ts` |
| Cart (to add) | `packages/plugins/commerce/src/handlers/cart.ts` (MVP) |
| Order read | `packages/plugins/commerce/src/handlers/checkout-get-order.ts` |
| Finalize | `packages/plugins/commerce/src/orchestration/finalize-payment.ts` |
| Finalize tests | `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts` |
| Webhook | `packages/plugins/commerce/src/handlers/webhooks-stripe.ts` |
| Schemas | `packages/plugins/commerce/src/schemas.ts` |
| Errors / wire codes | `packages/plugins/commerce/src/kernel/errors.ts`, `api-errors.ts` |
| Receipt decisions | `packages/plugins/commerce/src/kernel/finalize-decision.ts` |
| Plugin entry | `packages/plugins/commerce/src/index.ts` |

### Plugin HTTP routes (mount: `/_emdash/api/plugins/emdash-commerce/<route>`)

| Route | Role |
|-------|------|
| `cart/upsert` | Create or update a `StoredCart`; issues `ownerToken` on first creation |
| `cart/get` | Read-only cart snapshot; `ownerToken` required when cart has `ownerTokenHash` (guest possession proof) |
| `checkout` | Create `payment_pending` order + attempt; idempotency; `ownerToken` when cart has `ownerTokenHash` |
| `checkout/get-order` | Read-only order snapshot; `finalizeToken` required — `orderId` alone is never enough |
| `webhooks/stripe` | Verify signature → finalize |
| `recommendations` | Disabled contract for UIs |

### Insights

- Handlers are **contract + I/O**; money and replay rules stay in orchestration/kernel.
- Branch on **wire `code`**, not free-form `message` text.
- Logs: finalize paths use consistent context (`orderId`, `providerId`, `externalEventId`, `correlationId`) where implemented—preserve when extending.

### Gotchas

- Rate limits and idempotency keys must fail safe (see checkout).
- Do not leak `finalizeTokenHash` in public JSON—`checkout/get-order` already strips it.
- Installing the plugin in a site: register `createPlugin()` / `commercePlugin()` in Astro `emdash({ plugins: [...] })` and add `@emdash-cms/plugin-commerce` as a dependency—see [`packages/plugins/commerce/src/index.ts`](packages/plugins/commerce/src/index.ts) JSDoc.

## 5) Key files and directories

- **Package:** `packages/plugins/commerce/` (`package.json`, `src/`, `vitest.config.ts`)
- **Index of commerce docs:** [`packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`](packages/plugins/commerce/COMMERCE_DOCS_INDEX.md)
- **Architecture (broad reference):** [`commerce-plugin-architecture.md`](commerce-plugin-architecture.md) — stage-1 code may not implement every catalog route listed there; trust the plugin `routes` object as source of truth for what exists today.

## 6) Core lock-down policy (external developer rule)

Do not widen the transaction core by default. Only change finalize/checkout **internals** when:

- A regression is reproducible (test or production failure), **and**
- A new test first captures the bug/failure mode, **and**
- The change is narrowly scoped to that scenario.

When no bug is present, prefer operational hardening, targeted tests/types, and documentation alignment.

Do not add speculative abstractions or cross-scope features (shipping, tax, swatches, bundles, second gateway, heavy repository layers) until partial-failure and idempotency semantics stay stable under tests and incident handling.

**MVP cart work is explicitly allowed:** it is **new routes** that write/read `StoredCart` the same shape `checkout` already expects—**not** a rewrite of checkout/finalize.

## 7) Next developer: MVP “product → cart → checkout” execution brief

**Objective:** Ship the smallest **backend** surface so a site (e.g. Astro SSR) can populate `carts`, call existing `checkout`, and optionally drive finalize—**without** duplicating validation or touching finalize logic.

**Chosen approach (DRY/YAGNI):**

1. **T1 — Cart API:** `POST cart/upsert` and `POST cart/get` on the commerce plugin (same patterns as other routes: `requirePost`, Zod input, `throwCommerceApiError`).
2. **T2 — Validation:** shared Zod fragments in `schemas.ts` so cart line items match what [`checkout.ts`](packages/plugins/commerce/src/handlers/checkout.ts) already validates (`quantity`, `inventoryVersion`, `unitPriceMinor`, bounds).
3. **T3 — Fixtures:** in tests only, `inventoryStock.put(...)` + `carts.put` via handlers—no dev-only seed routes unless product asks.
4. **T4 — Proof:** one Vitest chain: upsert cart → checkout → assert order `payment_pending` and idempotency; optional webhook simulation using existing stripe test helpers where feasible.
5. **T5 — Docs:** update [`COMMERCE_DOCS_INDEX.md`](packages/plugins/commerce/COMMERCE_DOCS_INDEX.md) and this file’s route table; keep [`commerce-plugin-architecture.md`](commerce-plugin-architecture.md) alignment **only** where it reduces confusion (do not rewrite the whole doc).

**Explicit non-goals for this MVP:**

- No new product/catalog collections inside the plugin.
- No EmDash user session for carts yet (anonymous guest uses `cartId` + `ownerToken` as possession proof; logged-in cart retention is a future slice).
- No auto-creating inventory rows from cart upsert (keeps inventory semantics honest).
- No changes to `finalizePaymentFromWebhook` except if a **proven** regression appears (then follow §6).

**Acceptance criteria (checklist):**

- [x] `cart/upsert` persists a `StoredCart` readable by `checkout` for the same `cartId`.
- [x] `cart/get` returns 404-class semantics for missing cart (`CART_NOT_FOUND` family) and requires `ownerToken` when the cart has `ownerTokenHash`.
- [x] Invalid line items fail at cart boundary with same invariants as checkout would enforce.
- [x] `pnpm test` and `pnpm typecheck` pass in `packages/plugins/commerce` (84/84 tests, 0 type errors).
- [x] At least one test chains cart → checkout without manual storage pokes in production code paths.
- [x] Cart ownership model: `ownerToken` issued on creation, hash stored, required on subsequent reads, mutations, and checkout.

**After MVP:** wire `demos/simple` (or your site) with HTML-first forms/SSR calling plugin URLs; Playwright e2e can wait until a minimal storefront page exists.

## 8) Execution order (onboarding checklist)

1. `pnpm install` at repo root.
2. `cd packages/plugins/commerce && pnpm test && pnpm typecheck`.
3. Read §6 and §7; implement cart routes + tests per §7; do not refactor finalize/checkout unless §6 applies.
4. Update [`COMMERCE_DOCS_INDEX.md`](packages/plugins/commerce/COMMERCE_DOCS_INDEX.md) and §4 route table here when routes ship.
5. For local site testing: add `@emdash-cms/plugin-commerce` to the demo/site `package.json`, register the plugin in `astro.config.mjs`, run `pnpm dev`, call plugin URLs under `/_emdash/api/plugins/emdash-commerce/...`.
