# EmDash Ecommerce/Cart Plugin — High-Level Plan

## 1) Recommended architecture

Implement this as a **trusted plugin** initially.

`trusted` is the practical choice because:

- custom API routes are required for cart/checkout flows
- rich admin pages/widgets are needed for order and product operations
- optional Portable Text blocks with custom rendering are required for editor insertion of product actions

`packages/plugins/forms` demonstrates the trusted pattern and `docs/src/content/docs/plugins/sandbox.mdx` documents these constraints.

## 2) Plugin capabilities and security

Use explicit capability declarations:

- `read:content`, `write:content` (if products are also represented in core content)
- `network:fetch` (payment gateway, shipping, fulfillment APIs)
- `email:send` (order email notifications)
- `read:users` (optional, for registered customers)
- `read:media`, `write:media` (optional, for product media workflows)

Set `allowedHosts` narrowly to gateway and external service endpoints only (avoid `*` unless required for local dev).

## 3) Data model in plugin storage

Use `ctx.storage` as the canonical structured commerce store:

### Collections

- `products`
  - fields: `sku`, `slug`, `name`, `basePrice`, `currency`, `active`, `stockQty`, `images`, `metadata`
  - indexes: `sku`, `slug`, `active`, `category`, `createdAt`
- `carts`
  - fields: `cartId`, `userId`/`visitorId`, `status`, `expiresAt`, `currency`, `discountCode`, `updatedAt`
  - indexes: `userId`, `status`, `expiresAt`
- `cartItems`
  - fields: `cartId`, `productId`, `variantId`, `qty`, `unitPrice`, `lineTotal`
  - indexes: `cartId`, `productId`
- `orders`
  - fields: `orderNumber`, `cartId`, `userId`, `customerSnapshot`, `subtotal`, `tax`, `shipping`, `total`, `status`, `paymentStatus`, `paymentProviderRef`, `createdAt`, `updatedAt`
  - indexes: `status`, `paymentStatus`, `userId`, `createdAt`
- `orderEvents` (optional audit trail)
  - fields: `orderId`, `event`, `actor`, `payload`, `createdAt`
  - indexes: `orderId`, `createdAt`

If available, use `uniqueIndexes` for stable identifiers such as `orderNumber`/`sku` and enforce uniqueness in handlers.

## 4) KV keys (`ctx.kv`)

Use KV for operational config/state:

- `settings:commerce:provider` (gateway choice, region config)
- `settings:commerce:taxRates` (tax profiles/rules)
- `state:cart:expiryMinutes`
- `state:webhook:dedupe:<providerEventId>` (idempotency/replay protection)

Prefixing by `settings:` and `state:` helps avoid collisions and keeps maintenance simple.

## 5) Public API routes (trusted plugin routes)

Implement REST-style plugin routes under `/_emdash/api/plugins/emdash-commerce/...`:

### Cart

- `products.list` / `products.get`
- `cart.createOrResume`
- `cart.addItem`
- `cart.updateItem`
- `cart.removeItem`
- `cart.get`

### Checkout

- `checkout.create`
  - validate cart state and inventory
  - freeze price snapshot
  - create order with status `pending`
  - call payment provider session/intent endpoint via `ctx.http.fetch`
- `checkout.confirm`
  - webhook handler
  - verify signature and idempotency
  - finalize order status and payment status
  - decrement inventory and send notifications

### Optional support endpoints

- `shipping.estimate`
- `discount.apply`
- `coupon.validate`

## 6) Admin UI

Use `admin.pages` and `admin.widgets` for merchant workflows:

- Product management page (create/edit/archive products)
- Order management page (status transitions, refunds, notes)
- Dashboard widget (today’s revenue, open carts, low stock, payout health)

If using blocks for editor insertion, include plugin block metadata; rendering belongs to site-side Astro component integration in trusted mode.

## 7) Payment model

`@emdash-cms/x402` is a good EmDash-native primitive, useful for content-paywall styles or simple pay-per-content use-cases.

For full cart checkout, start with direct gateway integration (one provider first), with a provider abstraction behind plugin settings to allow later expansion.

## 8) Lifecycle and operational hooks

- `plugin:install` / `plugin:activate`
  - bootstrap default indexes/seed any required config references
- `plugin:deactivate` / `plugin:uninstall`
  - clean up job state and optional temp data
- `cron` hook
  - clear expired carts
  - emit abandoned-cart reminders (email optional)
- `content`/`email` hooks
- `beforeSave/afterSave` hooks if inventory or order snapshots rely on content updates

## 9) Transactional and reliability safeguards

- EmDash plugin storage does not expose low-level DB transaction docs as primary contract, so use deterministic state guards:
  - validate and lock inventory before order creation
  - move orders through explicit states (`pending` → `authorized` → `paid` → `fulfilled`)
  - keep webhook handlers idempotent using dedupe keys
  - avoid double-charging and double-reserve by re-checking stock/status transitions

## 10) Implementation phases (iterative, low risk)

1. **Phase 1 (MVP)**: plugin descriptor, product/cart storage, public cart API routes.
2. **Phase 2**: checkout + payment session + webhook verification + order creation lifecycle.
3. **Phase 3**: admin pages/widgets, email confirmations, basic reporting metrics.
4. **Phase 4**: taxes/shipping/discounts, provider abstraction, abandoned cart automation.
5. **Phase 5**: polish (validation, logging, test coverage, docs, observability).

## 11) Practical next steps

From here:

1. Scaffold plugin package (`packages/plugins/commerce`) with `definePlugin` and typed route handlers.
2. Implement `products`, `carts`, `orders` storage and minimal route handlers for adding/removing/reading cart.
3. Add checkout creation + basic payment provider integration.
4. Add admin list pages and KPI widget.

## Reference files to mirror while implementing

- `packages/core/src/plugins/types.ts` for plugin contracts
- `docs/src/content/docs/plugins/overview.mdx`
- `docs/src/content/docs/plugins/sandbox.mdx`
- `docs/src/content/docs/plugins/storage.mdx`
- `packages/plugins/forms/src/index.ts` and `packages/plugins/forms/src/handlers/submit.ts` for full-featured route/hook/admin patterns
- `docs/src/content/docs/guides/x402-payments.mdx` for payment strategy context
