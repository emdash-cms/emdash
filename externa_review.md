# External developer review — EmDash commerce plugin

This document gives **reviewers** enough context to evaluate **`@emdash-cms/plugin-commerce`** without assuming prior EmDash knowledge. It is maintained at the **repository root** as `externa_review.md`. A correctly spelled alias is `external_review.md` (one-line pointer to this file).

---

## 1. What you are reviewing

| Item | Detail |
|------|--------|
| **Scope** | The npm workspace package at `packages/plugins/commerce/` (TypeScript source, tests, and package-local docs). |
| **Product** | Stage-1 **commerce kernel**: guest cart in plugin storage → **checkout** (idempotent) → **Stripe-shaped webhook** → **finalize** (inventory + order state), plus read-only helpers. |
| **Out of scope for this zip** | EmDash core (`packages/core`), Astro integration internals, storefront themes, and the full monorepo — unless you clone the parent repo for integration testing. |

A **prepared archive** (see §8) contains this folder **without** `node_modules`, plus **all other repository `*.md` files** (for context) and **no** embedded zip files.

---

## 2. Host platform (EmDash) — minimal facts

- **EmDash** is an Astro-native CMS with a **plugin model**: plugins declare **capabilities**, **storage collections**, **routes**, and optional **admin settings**; handlers receive a **sandboxed context** (`storage`, `kv`, `request`, etc.).
- The CMS and plugin APIs are **still evolving** (early / beta). Do **not** infer guarantees from WooCommerce or WordPress plugin patterns.
- This plugin targets **Cloudflare-style** deployment assumptions in places (e.g. Workers); some handlers use **`node:crypto`** for Stripe webhook HMAC — runtime compatibility is an explicit review dimension.

Authoritative high-level product context (optional reading if you clone the full repo):

- `docs/best-practices.md` — EmDash plugin constraints, commerce-relevant risks, capability manifest discipline.
- `HANDOVER.md` — **execution handoff** for this plugin (routes table, lock-down policy, acceptance criteria, known issues).
- `commerce-plugin-architecture.md` — long-form architecture; **the implemented surface is whatever `src/index.ts` registers** — the big doc may describe future routes.

---

## 3. Package layout (under `packages/plugins/commerce/`)

```
packages/plugins/commerce/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── COMMERCE_DOCS_INDEX.md    # Doc index for this package
├── AI-EXTENSIBILITY.md       # Future LLM / MCP notes (non-normative for stage-1)
├── PAID_BUT_WRONG_STOCK_RUNBOOK*.md
└── src/
    ├── index.ts              # createPlugin(), commercePlugin(), route + storage wiring
    ├── types.ts              # StoredCart, StoredOrder, ledger/stock shapes
    ├── schemas.ts            # Zod inputs per route
    ├── storage.ts            # COMMERCE_STORAGE_CONFIG (indexes, uniqueIndexes)
    ├── settings-keys.ts      # KV key naming for admin settings
    ├── route-errors.ts
    ├── hash.ts
    ├── handlers/             # cart, checkout, checkout-get-order, webhooks-stripe, cron, recommendations
    ├── kernel/               # errors, idempotency key, finalize decision, limits, rate-limit window, api-errors
    ├── lib/                  # cart-owner-token, cart-lines, cart-fingerprint, cart-validation, merge-line-items, rate-limit-kv, etc.
    ├── orchestration/        # finalize-payment.ts (webhook-driven side effects)
    └── catalog-extensibility.ts
```

---

## 4. HTTP routes (mount path)

Base pattern (confirm in host app docs if needed):

`/_emdash/api/plugins/emdash-commerce/<route>`

| Route | Method | Role (summary) |
|-------|--------|------------------|
| `cart/upsert` | POST | Create/update cart; issues `ownerToken` once; stores `ownerTokenHash` |
| `cart/get` | POST | Read cart; requires `ownerToken` when `ownerTokenHash` exists |
| `checkout` | POST | Idempotent checkout; requires `ownerToken` when cart has `ownerTokenHash`; `Idempotency-Key` header or body |
| `checkout/get-order` | POST | Order snapshot; requires `finalizeToken` when order has `finalizeTokenHash` |
| `webhooks/stripe` | POST | Stripe signature verify → `finalizePaymentFromWebhook` |
| `recommendations` | POST | Disabled stub (`enabled: false`) for UIs |

All mutating/list routes use **`requirePost`** (reject GET/HEAD).

---

## 5. Security & data model (review focus)

1. **Guest possession:** `ownerToken` (raw, client-held) vs `ownerTokenHash` (stored). Same idea as `finalizeToken` / `finalizeTokenHash` on orders.
2. **Legacy carts/orders:** Carts or orders **without** hashes may have weaker or backward-compat behavior — see handlers and tests.
3. **Idempotency:** Checkout keys combine route, `cartId`, `cart.updatedAt`, content fingerprint, and client idempotency key.
4. **Rate limits:** KV-backed fixed windows on cart mutation, checkout (per IP hash), webhooks (per IP hash).
5. **Documented concurrency limit:** Finalize code states that **same-event concurrent workers** can still race; storage lacks a true **claim** primitive — see comments in `finalize-payment.ts`.

---

## 6. How to run tests and typecheck

The package depends on **`emdash`** and **`astro`** as **workspace / catalog** peers (`package.json`). **Inside the zip alone**, `pnpm install` will not resolve `workspace:*` until linked to the monorepo or patched to published versions.

**Recommended (full monorepo clone):**

```bash
pnpm install
cd packages/plugins/commerce
pnpm test
pnpm typecheck
```

**Test count:** run `pnpm test` — the number of tests changes over time; do not rely on stale counts in older docs.

---

## 7. Suggested review checklist

1. **Correctness:** Cart → checkout → finalize invariants; idempotency replay; inventory ledger vs stock reconciliation.
2. **Security:** Token requirements on cart read, cart mutate, checkout, order read; webhook signature path; information leaked via error messages or timing.
3. **Concurrency / partial failure:** Documented races; `pending` vs `processed` receipt semantics; operator runbooks.
4. **API design:** POST-only routes, wire error codes (`COMMERCE_ERROR_WIRE_CODES`), versioning of stored documents.
5. **Platform fit:** `PluginDescriptor` vs `definePlugin` storage typing (`commercePlugin()` uses a cast — intentional); `node:crypto` / `Buffer` in Workers.
6. **Maintainability:** DRY vs duplication (e.g. validation at boundary + kernel); clarity of comments vs behavior.
7. **Documentation:** `HANDOVER.md`, `COMMERCE_DOCS_INDEX.md`, and code comments — consistency with implementation.

---

## 8. Zip archive contents

The file **`commerce-plugin-external-review.zip`** (created at the **repository root**) contains:

- **`packages/plugins/commerce/`** — full plugin tree **excluding** `node_modules/` and `.vite/` (and other generated artifacts under that path).
- **Every `*.md` file** in the repository, with paths preserved, **except** files under any `node_modules/` or `.git/`. This adds root docs (e.g. `HANDOVER.md`, `commerce-plugin-architecture.md`), `docs/`, templates, skills, etc., for full written context alongside the plugin code.
- **No `*.zip` files** are included (the bundle itself is not packed into the archive).

Regenerate from the **repository root**:

```bash
./scripts/build-commerce-external-review-zip.sh
```

That script rsyncs `packages/plugins/commerce/` (excluding `node_modules/` and `.vite/`), copies every `*.md` under the repo (excluding `node_modules/` and `.git/`), strips any stray `*.zip` from the staging tree, and writes `commerce-plugin-external-review.zip`.

The archive is **gitignored** (`*.zip` in `.gitignore`); keep it local or attach from disk for the reviewer.

---

## 9. Contact / expectations

- Prefer **concrete findings** (file + symbol + scenario) and **severity** (blocker / major / minor / nit).
- Separate **“bugs in this plugin”** from **“EmDash platform gaps”** so maintainers can triage upstream vs package fixes.

---

*Generated for external code review. Plugin version at time of writing: see `packages/plugins/commerce/package.json`.*
