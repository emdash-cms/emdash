# Third-party technical review (round 2) — EmDash-native commerce

> Historical review packet (round 2). Current canonical review entrypoint is:
> - `@THIRD_PARTY_REVIEW_PACKAGE.md`
> - `external_review.md`
> - `SHARE_WITH_REVIEWER.md`

**Document purpose:** Give an external developer enough context to assess whether the **EmDash e-commerce / cart plugin** program is on a sound, optimal path **after** architecture hardening, a first internal review, platform alignment notes, and a small **kernel code** scaffold—not just paper design.

**How to use this file:** Read §1–3, then the files listed in **§4 Review bundle** (inside `latest-code_2.zip`) in order. Answer **§5** with concrete risks, alternatives, and section references.

---

## 1. Ecosystem: EmDash in one paragraph

EmDash is an **Astro-based CMS** with a **TypeScript plugin** model. Plugins receive a scoped **`ctx`**: **`ctx.storage`** (indexed document collections), **`ctx.kv`**, **`ctx.http.fetch`** (with **`network:fetch`** + **`allowedHosts`** when sandboxed), **`ctx.email`**, **`ctx.content`**, **`ctx.media`**, **`ctx.users`**, **`ctx.cron`**, etc., according to **declared capabilities**.

- **Trusted** plugins run in-process (full Node where the host allows it); capabilities are mainly documentary.
- **Sandboxed** plugins run in **Cloudflare Workers isolates** with **enforced** capabilities, **CPU/subrequest limits**, and **Block Kit** admin UI (no arbitrary admin JS from the plugin).

**Native vs standard:** **Standard** plugins target marketplace + sandbox compatibility. **Native** plugins are the escape hatch for **React admin**, **Portable Text blocks**, and **Astro storefront components**—the commerce **core** is expected to be **native** for merchant UX and PT/Astro integration, while many **payment/shipping/tax** extensions remain **standard**.

Canonical platform description: bundled **`skills/creating-plugins/SKILL.md`** (see also [upstream](https://github.com/emdash-cms/emdash/blob/main/skills/creating-plugins/SKILL.md)).

**x402 vs cart:** EmDash ships **x402** for HTTP-native, often **per-request** content monetization. It is **not** a substitute for a product catalog, cart, and orders. Merchant-facing comparison: **`commerce-vs-x402-merchants.md`**.

---

## 2. Problem we are solving

**Pain:** WooCommerce-style **theme coupling**, **PHP hooks/filters**, and **plugins mutating global cart state**—hard to extend safely and hard to headless.

**Direction:** **Headless-first** (Astro storefront), **contract-driven** extensions (typed provider interfaces + registry), **explicit state machines** and **one finalization path** for payments/inventory, **EmDash primitives only** in the kernel (`ctx.*` in the plugin wrapper, not inside pure domain code).

WooCommerce PHP source is **not** in this repository (ignored); prior analysis used Store API patterns (cart session, route decomposition, checkout validation) as **non-binding** input.

---

## 3. Proposed solution (current snapshot)

### 3.1 Core deliverable

A **native** commerce plugin package providing:

- **Products** — discriminated **`type` + `typeData`** (simple, variable, bundle, digital, gift card); variants and attributes in separate collections.
- **Cart** — server-side cart, line items, merge rules for logged-in users, rate limits and payload bounds (§20).
- **Checkout & orders** — immutable **order snapshots**, rich **order/payment** state machines, **`finalizePayment`** as the single authority for post-payment inventory decrement (aligned with **payment-first** inventory policy).
- **Providers** — payment (Stripe, Authorize.net), later shipping/tax via **separate modules** and provider contracts.
- **Admin & storefront** — React admin + Astro components (phased after the first vertical payment slice).

Authoritative detail: **`commerce-plugin-architecture.md`** (§1–21).

### 3.2 Extension / provider model (refined)

- **Registry** in plugin storage for registered providers.
- **Contracts** exported from a future SDK package; **Zod**-validated route inputs where applicable.
- **Execution:** **In-process TypeScript adapters** for **first-party** gateways (fewer subrequests, simpler tests). **HTTP route delegation** to another plugin remains valid for **sandboxed** or marketplace extensions—same **interface**, different **wiring** (§4 architecture doc).

This supersedes an earlier draft that leaned on **HTTP-only** internal delegation.

### 3.3 Phasing (high level)

Reflects an internal “shrink v1, prove correctness first” pass (**`emdash-commerce-final-review-plan.md`**) merged into **`commerce-plugin-architecture.md` §13**:

1. **Phase 0** — Types, storage schema, state machines, error catalog, **no** business I/O.
2. **Phase 1** — **Kernel only** (pure domain + finalization idempotency); **no** React/Astro.
3. **Phase 2** — **One end-to-end slice: Stripe** (product → cart → checkout → webhook → finalize → email).
4. **Phase 3** — **Hardening tests** (duplicate webhook, inventory conflict, stale cart, etc.).
5. **Phase 4** — **Authorize.net** to **stress the payment abstraction** (auth/capture split).
6. Later — admin UX, storefront library, shipping/tax modules, MCP/AI tools.

**Note:** Product decision was “Stripe + Authorize.net in v1”; **implementation order** is **Stripe first**, second gateway **after** the path is proven—still satisfies “two implementations,” with lower risk.

### 3.4 Locked product decisions

See **`commerce-plugin-architecture.md` §15**:

| Topic | Decision |
|--------|-----------|
| Gateways | Stripe **and** Authorize.net (implementation **sequenced**; see §3.3). |
| Inventory | **Payment-first** finalize; explicit **`inventory_changed` / `payment_conflict`** handling. |
| Shipping / tax | **Separate module**; no shipping address/quote in core without it; multi-currency/localized tax with that family. |
| Identity | Logged-in **purchase history** + **durable cart**; guest cart **merge** on login (§17). |

### 3.5 Robustness, scale, and platform (new since round 1)

- **§20** — Payload caps, **KV rate limits**, **client `Idempotency-Key`** + **`idempotencyKeys`** collection, **webhook** composite unique **`(providerId, externalEventId)`**, **inventory ledger**, **circuit breaker** keys, cursor pagination, lean webhook handlers.
- **§21** — Alignment with **EmDash sandbox + capabilities** and **Workers bindings / SSRF** cautions; **x402** as complementary; **no `CF-Worker`-header auth**.

### 3.6 WooCommerce-derived backlog (optional post-v1)

Cart **revalidate on read**, **rounding policy**, **outgoing merchant webhooks**, **email matrix**, **customer vs internal notes**, **digital download grants**, **scheduled sales**, **per-customer limits**, **multi-capture** totals—captured in chat review; not all are yet spelled out in the architecture doc. Reviewer may suggest which belong in core vs modules.

### 3.7 Code that exists today

**`packages/plugins/commerce`** — early **kernel** only:

- Error metadata subset, **limits**, **idempotency key** validation, **rate-limit window** helper, **provider HTTP policy** constants, **`decidePaymentFinalize`** (pure idempotency / state guard) + **Vitest** tests.

**No** `definePlugin` wiring, **no** storage adapters, **no** Stripe integration yet.

---

## 4. Review bundle (`latest-code_2.zip`)

Extract and read in this order:

| # | Path | Role |
|---|------|------|
| 1 | `3rdpary_review_2.md` | This briefing + questions. |
| 2 | `commerce-plugin-architecture.md` | **Authoritative** full architecture (§1–21). |
| 3 | `emdash-commerce-final-review-plan.md` | External “tighten foundation” review that influenced §13–§19. |
| 4 | `commerce-vs-x402-merchants.md` | One-page **commerce vs x402** for product positioning. |
| 5 | `high-level-plan.md` | Original short sketch; superseded where it conflicts with (2). |
| 6 | `3rdpary_review.md` | **Round 1** review packet (historical context). |
| 7 | `skills/creating-plugins/SKILL.md` | EmDash plugin model **ground truth**. |
| 8 | `packages/plugins/forms/src/index.ts` | Reference: descriptor + `definePlugin` + routes + hooks. |
| 9 | `packages/plugins/forms/src/storage.ts` | Storage index / `uniqueIndexes` pattern. |
| 10 | `packages/plugins/forms/src/schemas.ts` | Zod route inputs. |
| 11 | `packages/plugins/forms/src/types.ts` | Domain types. |
| 12 | `packages/plugins/forms/src/handlers/submit.ts` | Public handler: validation, media, storage, email, webhook. |
| 13 | `packages/plugins/commerce/package.json` | Commerce package metadata + exports. |
| 14 | `packages/plugins/commerce/tsconfig.json` | TS config. |
| 15 | `packages/plugins/commerce/vitest.config.ts` | Tests. |
| 16 | `packages/plugins/commerce/src/kernel/*.ts` | Kernel modules + tests. |

**Not bundled:** `node_modules`, full `packages/core` sources, WooCommerce tree, upstream EmDash `docs/` tree (use [GitHub](https://github.com/emdash-cms/emdash) for `PluginContext` and plugin overview MDX).

---

## 5. What we want from you (review questions)

Please be direct. Prefer **severity** (blocker / major / minor / nit), **alternatives**, and **§ references** into `commerce-plugin-architecture.md`.

### A. Architecture and phasing

1. Is **kernel-first → Stripe vertical slice → hardening → second gateway** the right ordering for **risk** vs **time-to-feedback**?
2. Does **§20** go too far for v1, or is it about right for **production-shaped** first release?

### B. Provider model and Cloudflare

3. Is **in-process first-party adapters + HTTP only when sandbox requires** coherent, or would you **standardize on one** mechanism?
4. Any **systematic** failure modes on **sandboxed** provider plugins (subrequests, CPU) we still underestimate?

### C. Data model and money

5. **`inventoryVersion` + ledger + payment-first finalize** — sufficient **concurrency** story, or missing **compare-and-swap** / transactions explicitly?
6. Where should **tax/rounding** policy be **pinned** so totals are reproducible (per line vs per order)?

### D. Security and abuse

7. **Rate limits + idempotency keys + webhook composite unique** — gaps vs real **card testing** or **replay** attacks?
8. **SSRF / user-controlled URLs** — any commerce feature we should **forbid by design** (see §21)?

### E. Extensibility and “plugin soup”

9. Top **three** guardrails to avoid **Woo-style** accidental coupling—are **events-only** (no filters) + **provider contracts** + **layer boundaries** enough?
10. Should **outgoing merchant webhooks** be **core** earlier than post-v1?

### F. AI / ops

11. **MCP later** vs **OpenAPI-first** for agent integration—which would you prioritize after checkout works?
12. **Observability §19** — missing **must-haves** for on-call?

### G. x402 and positioning

13. Is **`commerce-vs-x402-merchants.md`** accurate and sufficient to avoid **internal** product confusion?

---

## 6. How to return feedback

Short written review is enough. Link suggestions to **`commerce-plugin-architecture.md` sections** where possible.

Thank you for the review.
