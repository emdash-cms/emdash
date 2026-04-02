# EmDash Commerce Plugin — Final Review Direction and Implementation Plan

## Purpose

This document is the final direction for the EmDash commerce project after reviewing:

- `3rdpary_review.md`
- `commerce-plugin-architecture.md`
- `high-level-plan.md`
- `skills/creating-plugins/SKILL.md`
- the bundled Forms plugin reference files

It is written as a practical handoff for the current developer. The goal is not to restart the project. The goal is to sharpen the foundation now, before implementation choices calcify.

---

## Executive verdict

The project is on a **promising path** and the current architecture shows strong judgment in several key areas:

- EmDash-native commerce is the right framing.
- Typed contracts are the right answer to WooCommerce-style hook chaos.
- Headless Astro storefronts are the right default.
- Orders should be snapshots, not live joins into mutable catalog state.
- Inventory, payments, and order finalization should be treated as the real core.
- Designing for AI-readable and machine-usable operations is a good long-term choice.

However, I do **not** recommend proceeding unchanged.

The current plan is directionally strong, but it still risks being:

- a little too abstract too early,
- slightly too HTTP-centric internally,
- too broad in surface area for v1,
- and not explicit enough yet on state machines, idempotency, and finalization correctness.

So the correct move is:

> **Keep the core philosophy. Tighten the boundaries. Shrink the first executable slice. Freeze the dangerous semantics now.**

---

## Final recommendation in one sentence

Build this as a **small, correctness-first commerce kernel with one brutally real end-to-end slice**, and delay formal complexity until it is justified by real pressure.

---

## What should remain from the current plan

These parts are sound and should remain in place.

### 1. EmDash-native commerce, not WooCommerce mimicry

Do not reproduce:

- WordPress theme coupling
- mutable global hooks
- template override sprawl
- inheritance-heavy product logic
- extension-by-side-effect

That is exactly the trap this project should avoid.

### 2. Typed contracts over loose extensibility

The architecture should stay contract-driven. Provider integrations should be typed, explicit, versioned, and narrow.

### 3. Products as discriminated unions

`type` + `typeData` is the correct direction. It is materially better than invasive inheritance trees.

### 4. Orders as immutable snapshots

Orders should embed commercial facts captured at checkout time. Do not make historical order integrity depend on live product rows.

### 5. Shipping and tax outside the kernel

Do not let shipping/tax complexity contaminate the first kernel. Keep them modular.

### 6. Durable logged-in carts

The logged-in durable-cart direction is correct, provided merge rules are explicitly defined.

---

## Where the current plan should change

## 1. Do not make internal HTTP delegation the default architectural boundary

The current architecture leans toward a provider registry where the core calls provider routes over HTTP. The contract idea is good. The default execution model is not ideal.

### Why this should change

Within EmDash, especially with sandbox and Cloudflare-style constraints, making internal extension boundaries look like network boundaries too early creates avoidable problems:

- more failure modes
- more subrequest pressure
- more timeout and retry complexity
- harder local testing
- awkward trust/auth assumptions between plugins
- premature coupling to route mechanics instead of domain contracts

### Recommended correction

Keep the provider registry, but support **three execution modes** conceptually:

- `local` — direct in-process contract implementation
- `internal` — route-mediated/internal adapter only where isolation is genuinely needed
- `external` — real provider/webhook/API boundary

For v1, prefer this rule:

> **All core provider integrations should behave as local adapters first.**
> External API calls should happen inside the provider adapter itself.
> Do not add route-mediated internal delegation unless a real need appears.

This preserves the contract model without forcing faux-network architecture inside the system.

---

## 2. Shrink v1 to a real vertical slice

The strongest devil’s-advocate critique is valid: the project risks solving for year three before proving month one.

### The v1 slice should prove only this

A customer can:

1. view a simple product,
2. add it to a cart,
3. start checkout,
4. pay through one real gateway,
5. create a correct order snapshot,
6. finalize inventory safely,
7. see the order in admin,
8. and recover correctly from expected failure cases.

That is the minimum slice that proves the foundation.

### Therefore, v1 should exclude or defer

- advanced bundle behavior
- rich analytics
- broad AI tooling
- MCP surfaces
- multiple storefront component families
- generalized fulfillment abstraction
- tax/shipping sophistication
- broad content block ecosystems
- aggressive event/platform generalization

The right question for the first milestone is:

> **Can this system survive a real purchase flow correctly and repeatedly?**

If yes, then the architecture is earning its abstractions.

---

## 3. Separate the architecture mentally now, even if code packaging stays simple initially

I do recommend a conceptual split immediately, but not necessarily a heavy package split on day one.

### Recommended conceptual layers

#### Layer A — Commerce kernel
Pure domain logic only:

- product and variant domain rules
- cart logic
- pricing/totals
- order creation
- inventory transitions
- provider interfaces
- state transitions
- error codes
- idempotency model
- domain events

No admin UI. No Astro. No React. No MCP.

#### Layer B — EmDash plugin wrapper
EmDash-specific glue:

- plugin descriptor
- capabilities
- storage declarations
- routes
- config
- hook wiring

#### Layer C — Admin UI
Merchant-facing UI only.

#### Layer D — Storefront UI
Astro components and display primitives only.

### Practical instruction

For now, one repo and even one plugin package is acceptable if needed for speed. But the directories, imports, and tests must enforce these boundaries.

Do **not** let kernel logic depend on admin/storefront concerns.

---

## 4. Freeze the dangerous semantics before implementation expands

There are a few areas where ambiguity is expensive. These must be explicitly written down before major coding continues.

### A. Order state machine
Define the allowed order states and transitions centrally.

Suggested initial order states:

- `draft`
- `payment_pending`
- `paid`
- `processing`
- `fulfilled`
- `canceled`
- `refund_pending`
- `refunded`
- `payment_conflict`

### B. Payment state machine
Suggested initial payment states:

- `requires_action`
- `pending`
- `authorized`
- `captured`
- `failed`
- `voided`
- `refund_pending`
- `refunded`
- `partial_refund`

### C. Cart state machine
Suggested initial cart states:

- `active`
- `converted`
- `expired`
- `abandoned`
- `merged`

Do not let handlers improvise transitions independently.

---

## 5. Define inventory finalization precisely

The existing payment-first inventory direction is defensible, but only if its concurrency behavior is explicit.

### Recommended rule

The system should not perform inventory decrement as a scattered side effect. There must be **one authoritative finalization path**.

### Recommended flow

1. `checkout.create` validates the cart and creates a `payment_pending` order snapshot.
2. A payment attempt record is created.
3. The gateway flow begins.
4. On confirmation/webhook/callback, the system calls a single finalization function.
5. Finalization:
   - verifies idempotency,
   - verifies order state,
   - performs a final availability/version check,
   - decrements inventory,
   - marks order/payment states,
   - records events,
   - emits merchant/customer side effects after the transaction boundary.

### If inventory changed before finalize

The system must produce a specific, stable error/result path such as:

- `inventory_changed`
- `insufficient_stock`
- `payment_conflict`

And there must be a documented refund/void policy when payment succeeded but stock cannot be finalized.

---

## 6. Add an inventory ledger now

Do not rely only on mutating `stockQty`.

Create an explicit inventory transaction log from the beginning.

Suggested fields:

- `productId`
- `variantId`
- `delta`
- `reason`
- `actor`
- `referenceType`
- `referenceId`
- `createdAt`

This will pay off later in reconciliation, debugging, reporting, and support.

---

## 7. Freeze an error catalog early

The project already values machine-readable errors. Good. Now formalize them.

Suggested initial error catalog:

- `inventory_changed`
- `insufficient_stock`
- `cart_expired`
- `product_unavailable`
- `variant_unavailable`
- `payment_initiation_failed`
- `payment_confirmation_failed`
- `payment_already_processed`
- `provider_unavailable`
- `shipping_required`
- `feature_not_enabled`
- `invalid_discount`
- `currency_mismatch`
- `order_state_conflict`
- `webhook_signature_invalid`
- `webhook_replay_detected`

Every route should use a consistent structure for:

- machine code
- human message
- HTTP status
- optional retryability flag
- optional structured details

This is important for admin UX, storefront UX, AI tooling, and test reliability.

---

## 8. Add idempotency and webhook handling as first-class design elements

This is not a “later hardening” concern. It is part of the core.

### Minimum required records

- `paymentAttempts`
- `webhookReceipts`
- `idempotencyKeys`

Suggested stored facts:

- provider
- external request/event id
- order id
- status
- normalized payload reference or hash
- first seen timestamp
- processed timestamp

The system must tolerate:

- duplicate webhooks
- duplicate callbacks
- retried confirmations
- out-of-order provider events

---

## 9. Be more opinionated about the product model, but keep v1 narrow

The product model direction is good. The v1 feature set should still be narrow.

### Recommended v1 support

- simple products
- variable products only if truly necessary for the first slice
- digital as a small extension if trivial
- no heavy bundle semantics yet

### Product/variant fields worth settling now

#### Product
- `merchantSku` optional
- `publishedAt`
- `requiresShipping`
- `taxCategory`
- `defaultVariantId` if variants exist
- denormalized `searchText` or equivalent

#### Variant
- normalized option values
- `active`
- `sortOrder`
- `priceOverride`
- `compareAtPriceOverride`
- `stockQty`
- `inventoryVersion`

This is enough to avoid bad migrations later without opening too much scope now.

---

## 10. Define customer identity and cart merge rules now

Because logged-in durable carts are in scope, the merge semantics must be explicit.

Write down:

- whether guest checkout is allowed
- whether guest orders can later associate with a logged-in account by email
- what happens when a guest cart and user cart both exist on login
- whether line quantities merge, replace, or conflict
- what happens if merged items are no longer valid

These rules should not emerge accidentally from implementation details.

---

## 11. Promote observability to a mandatory workstream

The commerce core needs operational clarity from the beginning.

### Must-have observability

- correlation id across checkout/payment/finalization flow
- order timeline or event stream
- provider call logs with redaction
- webhook receipt logging
- inventory mutation logging
- actor attribution (`customer`, `merchant`, `system`, `agent`)
- stable structured error payloads

Do not postpone this until after the first gateway lands. It is part of making the first gateway safe to debug.

---

## Final project shape I recommend

## Principle
**Keep the architecture strong, but prove it with the smallest real flow possible.**

## Required approach
- domain-first
- correctness-first
- small-scope
- explicit-state
- contract-driven
- low-magic
- test-first around dangerous transitions

---

## Revised phased plan

## Phase 0 — Architecture hardening
This is the current highest-priority phase.

The developer should produce or revise the architecture docs so that the following are explicit and unambiguous:

1. order state machine
2. payment state machine
3. cart state machine
4. inventory finalization algorithm
5. provider execution model
6. idempotency model
7. webhook replay policy
8. error catalog
9. customer/cart merge rules
10. observability schema
11. compatibility/versioning policy for contracts and events

This phase should end with a short, crisp architecture addendum. Not more sprawling prose.

## Phase 1 — Minimal kernel implementation
Implement only the smallest kernel required for a real purchase flow:

- simple product model
- cart
- order snapshot creation
- totals
- payment attempt records
- inventory versioning
- inventory ledger
- idempotent finalization service
- error types
- domain event records

No rich storefront library. No broad admin system. No AI/MCP work.

## Phase 2 — One real vertical slice
Build one full flow end to end:

- product display
- add to cart
- cart view
- checkout start
- payment through one provider
- webhook/callback handling
- order finalize
- order visible in admin
- order timeline visible for debugging

Use one gateway only in this phase. Stripe is a sensible choice.

## Phase 3 — Hardening and test pressure
Before expanding features, harden the first slice.

Required tests:

- duplicate webhook
- retry after timeout
- inventory changed before finalize
- stale cart
- payment success plus inventory failure
- order finalization idempotency
- repeated callback replay
- cancellation/refund state transition guards

If the architecture bends badly here, adjust it now.

## Phase 4 — Second gateway to validate abstraction
Add a second gateway only after the first path is solid.

The point is not feature breadth. The point is testing whether the provider abstraction is actually correct.

If Authorize.net causes awkward branching or leaky abstractions, fix the contract before adding more providers.

## Phase 5 — Admin UX expansion
Only after the core transaction path is stable:

- better product editing
- order detail pages
- settings UI
- basic operational dashboards
- low-stock visibility

## Phase 6 — Storefront and extension growth
After correctness is proven:

- richer Astro components
- optional content blocks
- additional product types
- shipping/tax modules
- fulfillment abstractions
- AI/MCP surfaces

---

## Concrete instructions to the current developer

### Do next
1. Revise the architecture doc with the frozen semantics listed above.
2. Reduce the first milestone to one real end-to-end checkout path.
3. Treat provider integrations as local adapters first.
4. Implement one authoritative finalization path.
5. Add inventory ledger + payment/idempotency records immediately.
6. Keep kernel logic isolated from admin/storefront code.
7. Add tests around replay, concurrency, and state transitions before expanding features.

### Do not do yet
- do not build wide provider ecosystems
- do not formalize marketplace/plugin breadth too early
- do not build MCP surfaces yet
- do not over-generalize analytics/events
- do not add broad bundle logic
- do not optimize prematurely for many execution paths

### Watch for these anti-patterns
- HTTP-shaped architecture where simple local contracts would do
- admin/storefront code importing kernel internals in uncontrolled ways
- `meta` fields turning into a junk drawer
- handler-specific state transition logic
- payment side effects happening outside the finalization boundary
- growing abstractions without a real second implementation forcing them

---

## How I would rate the current project after this correction

### Current direction
Good. Promising. Worth continuing.

### Current architectural maturity
Not ready for broad implementation without one more tightening pass.

### Overall verdict
> **Proceed, but only after shrinking the first executable scope and freezing the risky semantics.**

That is the best path to a durable commerce foundation on EmDash.

---

## Acceptance criteria for the next review checkpoint

Before broader implementation proceeds, the developer should be able to show:

1. a revised architecture addendum covering the frozen semantics
2. a minimal kernel directory structure with clean boundaries
3. one implemented end-to-end simple-product checkout path
4. explicit state transition guards
5. idempotent payment finalization
6. webhook replay protection
7. inventory ledger records
8. structured errors with stable codes
9. tests covering duplicate finalize and stock-change failure cases
10. no unnecessary internal HTTP indirection in the core path

If those are in place, the project is on a strong foundation.

---

## Final note

The existing plan has real strengths. This is not a teardown. It is a correction toward sharper execution.

The right outcome is not “more architecture.”
The right outcome is:

- **fewer assumptions**
- **more explicit semantics**
- **one real, correct commerce flow**
- **and an architecture that earns its abstractions by surviving real pressure**
