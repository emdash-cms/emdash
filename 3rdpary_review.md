# Third-party technical review — EmDash-native commerce plugin

> Historical review packet. Superseded by `3rdpary_review_2.md` for the current project state.
> Canonical current review path:
> - `@THIRD_PARTY_REVIEW_PACKAGE.md`
> - `external_review.md`
> - `SHARE_WITH_REVIEWER.md`

**Document purpose:** Give an external developer enough context to judge whether the proposed **e-commerce / cart plugin for [EmDash CMS](https://github.com/emdash-cms/emdash)** is on a sound, optimal path—especially regarding extensibility, platform fit, and operational risk—**before** substantial implementation begins.

**Status:** Historical snapshot from before `packages/plugins/commerce` was added. Keep this file only for context on how the plan evolved.

**How to use this file:** Read this overview, then the bundled documents (see **Review bundle** below). Answer the questions in **What we want from you** with concrete suggestions, risks, and alternatives.

---

## 1. Ecosystem: EmDash in one paragraph

EmDash is an **Astro-based CMS** with a **plugin system** that extends the admin, content pipeline, and HTTP API. Plugins are **TypeScript packages**. They receive a **scoped context** (`ctx`) with:

- **`ctx.storage`** — document collections with indexes (plugin-scoped structured data).
- **`ctx.kv`** — key-value settings and operational state.
- **`ctx.http.fetch`** — outbound HTTP when the plugin declares **`network:fetch`** and **`allowedHosts`** (enforced when sandboxed).
- **`ctx.email.send`**, **`ctx.content`**, **`ctx.media`**, **`ctx.users`**, **`ctx.cron`**, etc., depending on **declared capabilities**.

Plugins run in two modes:

- **Trusted (in-process)** — full Node access; capabilities are documentary.
- **Sandboxed (Cloudflare Workers isolate)** — strict capability enforcement, resource limits, **Block Kit** admin UI (declarative JSON), no arbitrary plugin JS in the browser for admin.

**Native vs standard:** “Standard” plugins favor marketplace distribution and the same code path for trusted + sandboxed. **Native** plugins are the escape hatch for **React admin**, **Portable Text block types**, and **Astro site components** shipped from npm—required for rich merchant UIs and storefront components. The canonical author-facing description of this split is in the bundled **`skills/creating-plugins/SKILL.md`** (mirrors [upstream skill](https://github.com/emdash-cms/emdash/blob/main/skills/creating-plugins/SKILL.md)).

EmDash also ships **x402**-style payment integration for **content monetization**; that is **orthogonal** to a full cart (see `high-level-plan.md`).

---

## 2. Problem we are solving (why not “just use WooCommerce”?)

The product owner’s pain is **WooCommerce-style extensibility**: child themes, template overrides, opaque PHP hooks/filters, and stacks of plugins that fight over the same global cart/order hooks. The goal is a **legacy-free** commerce layer that is:

- **Headless-friendly** — storefront is **Astro**, not PHP templates.
- **Contract-driven** — extensions integrate through **typed boundaries**, not mutable global hooks.
- **EmDash-native** — storage, KV, routes, cron, email, capabilities—not a parallel framework inside the CMS.

A local **WooCommerce PHP tree** was used only as a **reference** for cart/checkout *ideas* (session tokens, route decomposition, validation); it is **not** part of the deliverable and is **gitignored** in this repo.

---

## 3. Proposed solution (executive summary)

### 3.1 Core deliverable

A **first-party commerce plugin** (`@emdash-cms/plugin-commerce` or equivalent) that provides:

- **Product catalog** — including **simple**, **variable** (many variants), **bundle**, **digital**, and **gift card** shapes via a **discriminated `type` + `typeData`** model (not class inheritance).
- **Cart** — server-side cart, totals, discounts (staged), line items.
- **Checkout & orders** — order lifecycle, payment handoff, webhooks, emails.
- **Admin** — products, orders, settings (React / native plugin trajectory).
- **Storefront** — **Astro components** + optional **Portable Text** blocks (native).

### 3.2 Extension model (the main architectural bet)

Instead of WordPress-style filters, **extensions register as providers** in a **registry** stored in plugin storage. The commerce core **calls provider routes over HTTP** (`ctx.http.fetch`) using **narrow, versioned contracts** (payment, shipping, tax, fulfillment). Third-party payment/shipping/tax plugins are **standard** (sandboxable, marketplace-friendly) where possible.

### 3.3 AI / agents

Design assumption: **merchants and operators will use LLM agents**. Therefore:

- Admin and automation surfaces expose **structured JSON** APIs.
- Errors use **stable machine codes** + human copy.
- A future **MCP**-oriented companion plugin is planned to expose tools (list products, adjust inventory, order actions, summaries).

Details: **`commerce-plugin-architecture.md`** (Sections 10–11).

### 3.4 Locked product decisions (already chosen)

Recorded in **`commerce-plugin-architecture.md` §15**:

| Topic | Decision |
|--------|-----------|
| Payment gateways (v1) | **Stripe** and **Authorize.net**—two real implementations early to stress-test the provider contract. |
| Inventory | **Payment-first; reserve/decrement at finalize** after successful payment. Explicit UX for **inventory changed** between cart and payment. |
| Shipping / tax | **Separate module**. Without it: **no shipping address / quote flows** in core. Multi-currency and localized tax lean toward **that module family**, not duplicated in core v1. |
| Logged-in users | **Purchase history** + **durable cart** across logout/login and devices; anonymous `cartToken` **merge/associate** on login. |

---

## 4. Documents in the review bundle (what to read in order)

The archive **`lates-code.zip`** at the repository root contains exactly these **nine** paths (read in this order):

| Order | Path in zip | Role |
|-------|-------------|------|
| 1 | `3rdpary_review.md` | Framing and review questions (this file). |
| 2 | `commerce-plugin-architecture.md` | **Authoritative** architecture: data model, routes, phases, Step 1 spec, locked decisions. |
| 3 | `high-level-plan.md` | Earlier, shorter sketch; useful for diffing scope drift; superseded by the architecture doc where they conflict. |
| 4 | `skills/creating-plugins/SKILL.md` | EmDash plugin anatomy, trusted vs sandboxed, capabilities, routes—**platform ground truth** for “are we using EmDash correctly?”. |
| 5 | `packages/plugins/forms/src/index.ts` | Forms plugin: descriptor + `definePlugin`, routes, hooks, admin. |
| 6 | `packages/plugins/forms/src/storage.ts` | Storage collection/index declaration pattern. |
| 7 | `packages/plugins/forms/src/schemas.ts` | Zod input schemas for routes. |
| 8 | `packages/plugins/forms/src/types.ts` | Domain types stored in `ctx.storage`. |
| 9 | `packages/plugins/forms/src/handlers/submit.ts` | Public route handler: validation, media, storage, email, webhooks. |

**Not bundled (too large or redundant):** full `packages/core/src/plugins/types.ts` — use the [repo](https://github.com/emdash-cms/emdash) or your checkout of EmDash for the complete `PluginContext` / capability types. Plugin overview docs live under `docs/src/content/docs/plugins/` in the upstream repo.

---

## 5. What we want from you (review questions)

Please be blunt. We are optimizing for **correctness, maintainability, and third-party extension ergonomics**—not for matching WooCommerce feature parity.

### 5.1 Platform fit

1. Is **native plugin** for commerce core + **standard plugins** for providers the right split for EmDash today?
2. Where would you **push back** on “provider registry + HTTP delegation” vs **in-process hooks** or **shared npm library** only (no runtime calls)?
3. Does the plan align with **sandboxed** constraints for extensions (CPU, subrequests, no Node in worker)? Any provider pattern that will **systematically fail** on Cloudflare?

### 5.2 Data model and commerce semantics

4. Is **`type` + `typeData` + separate `productVariants` / attributes** the right long-term model for bundles and variants?
5. **Payment-first inventory** reduces reservation complexity but increases **oversell risk** under concurrency. What mitigations would you require (optimistic locking, version fields, queue, last-chance validation UX)?
6. Should **orders** embed line items vs normalize to `orderLines` collection for reporting at scale?

### 5.3 Checkout and compliance

7. **Stripe + Authorize.net** early: does that meaningfully validate the abstraction, or would you add a **third** radically different gateway (e.g. redirect-only) in the first milestone?
8. PCI and webhook **security** (signature verification, idempotency, replay): what is **missing** from the written plan?

### 5.4 Extensibility vs WooCommerce

9. What WooCommerce **patterns** (if any) are we **under-weighting** that merchants still expect (e.g. fee lines, coupons, mixed carts, subscriptions)?
10. What are the top **three** ways this design could still end up as “plugin soup” like WordPress—and how to **prevent** them?

### 5.5 AI and operations

11. Is the **MCP / tool** strategy coherent, or would you standardize on **OpenAPI** + codegen first?
12. What **observability** (structured logs, correlation ids, order event stream) is mandatory for production?

### 5.6 Phasing

13. Is the **phase order** in `commerce-plugin-architecture.md` §13 sensible? What would you **reorder** or **merge**?

---

## 6. Known gaps and intentional non-goals (today)

- No **`packages/plugins/commerce`** implementation yet.
- **WooCommerce** source is excluded from version control; reviewers should not assume it is in the zip.
- **Fulfillment / shipping / tax** module is **explicitly out of core v1 scope** except as extension points.
- Diagrams in the architecture doc may name illustrative packages (e.g. PayPal in a tree); **§15** is authoritative for payment targets.

---

## 7. How to return feedback

A short written review (bullet risks + recommendations) is enough. Prefer:

- **Severity** (blocker / major / minor / nit).
- **Concrete alternative** where you disagree with the approach.
- **References** to sections in `commerce-plugin-architecture.md` so we can trace changes.

Thank you for the review.
