# EmDash Commerce Plugin — Architecture Plan

> This document supersedes the high-level-plan.md sketch and serves as the
> authoritative blueprint before any code is written. It defines principles,
> extension model, data model, route contracts, AI strategy, phased plan, and
> the complete specification for Step 1.

---

## 1. The Core Problem We Are Solving

WooCommerce's extensibility problems are not implementation bugs — they are
**architectural mismatches**:

- Theme/layout coupling (Storefront theme overrides, child themes, template
  hierarchy).
- Untyped PHP hook/filter system (`add_action`, `add_filter`) with no
  discoverability, no contracts, and no type safety.
- Extension plugins that mutate global cart state unpredictably.
- Product types implemented via class inheritance, making new types invasive.
- Admin UI built on WordPress core, requiring deep WP-specific knowledge.

Our solution makes different foundational decisions:

| Problem | Our answer |
|---|---|
| Layout coupling | Headless by default. Frontend is pure Astro. Plugin ships components, not themes. |
| Untyped hooks | Typed TypeScript event catalog. Hooks are observations, not filters. |
| Mutable global state | Immutable data flow. Cart/order state transitions are explicit and guarded. |
| Inheritance-based product types | Discriminated union + `typeData` blob. New types are additive, not invasive. |
| WP admin complexity | Block Kit (declarative JSON) for standard UI; React only where complexity demands it. |
| Extension plugin fragility | Provider registry contract. Extensions register themselves; core calls them via typed route contracts. |

---

## 2. Design Philosophy

**Correctness over cleverness.** Every mutation goes through an explicit state
check. No implicit side effects.

**Contracts are the product.** The TypeScript interfaces this plugin exports to
extension developers are the API surface. They must be stable, narrow, and
well-documented.

**EmDash-native primitives first.** `ctx.storage`, `ctx.kv`, `ctx.http`,
`ctx.email`, `ctx.cron` cover every need. No npm dependencies for core logic.

**AI as a first-class actor.** Every operation that a human merchant performs
must also be performable by an AI agent. This shapes route design, event
structure, and error semantics.

**YAGNI until the data model.** For the data model, think ahead — it is
expensive to migrate. For everything else, build the minimum that is correct.

---

## 3. Plugin Architecture Hierarchy

```
EmDash CMS Core
└── @emdash-cms/plugin-commerce           ← Native plugin (React admin, Astro, PT blocks)
    │
    ├── Provider extension points (Standard plugins — marketplace-publishable)
    │   ├── @emdash-cms/plugin-commerce-stripe     Payment provider
    │   ├── @emdash-cms/plugin-commerce-paypal     Payment provider
    │   ├── @emdash-cms/plugin-shipping-flat       Shipping provider
    │   ├── @emdash-cms/plugin-tax-simple          Tax provider
    │   └── @emdash-cms/plugin-commerce-mcp        MCP server for AI agents
    │
    └── Storefront extensions (Standard plugins — marketplace-publishable)
        ├── @emdash-cms/plugin-reviews             Product reviews
        ├── @emdash-cms/plugin-wishlist            Wishlist
        ├── @emdash-cms/plugin-loyalty             Points / loyalty
        └── @emdash-cms/plugin-subscriptions       Recurring billing
```

### Why native for the core plugin?

The commerce core requires:
- Complex React admin UI (product variant editor, order management, media upload).
- Astro components for frontend rendering (`<ProductCard>`, `<CartWidget>`, etc.).
- Portable Text block types (embed product in a content body).

These features are **native-only** per EmDash's plugin model. The plugin still
uses `ctx.*` APIs for all data access and produces no privileged side effects —
it is architecturally equivalent to a standard plugin in terms of isolation, but
needs the native execution context for its UI.

### Why standard for extension plugins?

Extension plugins (payment gateways, shipping, tax, reviews) have simple,
narrow concerns: implement a typed interface and expose one to three routes.
Standard format is sufficient, allows marketplace distribution, and can be
sandboxed — appropriate for third-party code.

---

## 4. Extension Framework Model

WooCommerce uses PHP abstract classes and hooks to let extension plugins add
payment gateways, shipping methods, and product types. This is powerful but
brittle. Our model uses the **provider registry pattern**.

### How it works

1. The commerce plugin defines typed **provider interfaces** as exported TypeScript
   types in a companion SDK package (`@emdash-cms/plugin-commerce-sdk`).

2. Extension plugins import the SDK, implement the interface, and call our
   `providers/register` route on `plugin:activate`. The registration record is
   stored in our `providers` collection.

3. At runtime (checkout, shipping estimate, tax calculation), our commerce
   plugin reads the active provider from storage, then delegates to the
   provider's route via `ctx.http.fetch`.

4. On `plugin:deactivate`, extension plugins call `providers/unregister`.

### Contracts (in `@emdash-cms/plugin-commerce-sdk`)

```
PaymentProviderContract
  - routes.initiate   → PaymentInitiateRequest → PaymentInitiateResponse
  - routes.confirm    → PaymentConfirmRequest  → PaymentConfirmResponse
  - routes.refund     → PaymentRefundRequest   → PaymentRefundResponse
  - routes.webhook    → raw webhook payload    → void

ShippingProviderContract
  - routes.getRates   → ShippingRateRequest    → ShippingRate[]

TaxProviderContract
  - routes.calculate  → TaxCalculationRequest  → TaxCalculationResponse

FulfillmentProviderContract
  - routes.fulfill    → FulfillmentRequest     → FulfillmentResponse
  - routes.getStatus  → { fulfillmentRef }     → FulfillmentStatus
```

### Key properties of this model

- **No class inheritance.** Extension plugins implement a structural interface.
- **No PHP-style filters.** Extensions cannot mutate core data mid-flow.
- **HTTP-native.** Provider calls are plain `fetch` — testable, observable,
  replaceable.
- **Type-safe contracts.** The SDK package exports Zod schemas matching the
  interfaces. Extension plugin authors get compile-time safety.
- **Multiple providers, one active.** The registry supports multiple registered
  providers per type. The merchant selects the active one in admin settings.
  Fallback behavior is defined per type.

---

## 5. Product Type Model

WooCommerce implements product types as PHP class inheritance. Adding a new type
means extending `WC_Product` and registering hooks everywhere. This is the
primary source of plugin complexity for most WooCommerce stores.

Our model uses a **discriminated union** with a `type` field and a `typeData`
JSON blob. The base product record is always the same. Type-specific fields live
in `typeData` and are validated in route handlers, not at the storage layer.

### Product type taxonomy

| Type | Description |
|---|---|
| `simple` | Single SKU, fixed price, tracked inventory |
| `variable` | Parent product with variants (color × size, etc.) |
| `bundle` | Composed of other products with optional pricing rules |
| `digital` | Downloadable file(s), no shipping, optional license limits |
| `gift_card` | Fixed or custom denomination, delivered by email |

New types are additive: define new `typeData` shape, add a validator, add a
route handler branch. Nothing in core changes.

### ProductBase (all types share this)

```typescript
interface ProductBase {
  type: "simple" | "variable" | "bundle" | "digital" | "gift_card";
  name: string;
  slug: string;                          // URL-safe, unique
  status: "draft" | "active" | "archived";
  descriptionBlocks?: unknown[];          // Portable Text
  shortDescription?: string;             // Plain text summary (for AI/search)
  basePrice: number;                     // Cents / smallest currency unit
  compareAtPrice?: number;               // Strike-through price
  currency: string;                      // ISO 4217
  mediaIds: string[];                    // References to ctx.media
  categoryIds: string[];
  tags: string[];
  seoTitle?: string;
  seoDescription?: string;
  typeData: Record<string, unknown>;     // Validated per type in handlers
  meta: Record<string, unknown>;         // Extension plugins store data here
  createdAt: string;
  updatedAt: string;
}
```

### Type-specific typeData shapes

```typescript
interface SimpleTypeData {
  sku: string;
  stockQty: number;
  stockPolicy: "track" | "ignore" | "backorder";
  weight?: number;                       // grams
  dimensions?: { length: number; width: number; height: number }; // mm
  shippingClass?: string;
  taxClass?: string;
}

interface VariableTypeData {
  attributeIds: string[];                // References productAttributes collection
  // Variants stored separately in productVariants collection
}

interface BundleTypeData {
  items: Array<{
    productId: string;
    variantId?: string;
    qty: number;
    priceOverride?: number;              // Override individual item price in bundle
  }>;
  pricingMode: "fixed" | "calculated" | "discount";
  discountPercent?: number;              // For pricingMode: "discount"
}

interface DigitalTypeData {
  downloads: Array<{
    fileId: string;
    name: string;
    downloadLimit?: number;
  }>;
  licenseType: "single" | "multi" | "unlimited";
  downloadExpiryDays?: number;
}

interface GiftCardTypeData {
  denominations: number[];               // Fixed amount options
  allowCustomAmount: boolean;
  minCustomAmount?: number;
  maxCustomAmount?: number;
}
```

### Product variants (for type: "variable")

Variants are stored in a separate `productVariants` collection. Each variant is
a complete purchasable unit with its own SKU, price, and stock.

```typescript
interface ProductVariant {
  productId: string;
  sku: string;
  attributeValues: Record<string, string>; // { color: "Red", size: "L" }
  price: number;
  compareAtPrice?: number;
  stockQty: number;
  stockPolicy: "track" | "ignore" | "backorder";
  mediaIds: string[];
  active: boolean;
  sortOrder: number;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### Product attributes (for type: "variable")

Attributes define the axis of variation (Color, Size). Terms define the values
(Red, Blue; Small, Medium, Large).

```typescript
interface ProductAttribute {
  name: string;
  slug: string;
  displayType: "select" | "color_swatch" | "button";
  terms: Array<{
    label: string;
    value: string;
    color?: string;                      // For displayType: "color_swatch"
    sortOrder: number;
  }>;
  sortOrder: number;
  createdAt: string;
}
```

---

## 6. Cart and Order Data Model

### Cart

```typescript
type CartStatus = "active" | "checkout" | "abandoned" | "converted" | "expired";

interface Cart {
  cartToken: string;                     // Opaque, used in Cookie / Authorization header
  userId?: string;                       // Set when authenticated user is identified
  status: CartStatus;
  currency: string;
  discountCode?: string;
  discountAmount?: number;
  shippingRateId?: string;              // Selected shipping rate ID from provider
  shippingAmount?: number;
  taxAmount?: number;
  note?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface CartItem {
  cartId: string;
  productId: string;
  variantId?: string;
  qty: number;
  unitPrice: number;                     // Cents. Frozen at time of add.
  lineTotal: number;                     // qty × unitPrice
  meta: Record<string, unknown>;         // Extension data (e.g., bundle composition)
  createdAt: string;
  updatedAt: string;
}
```

### Order state machine

```
pending
  ↓ (checkout.create called, payment session initiated)
payment_pending
  ↓ (payment provider webhook: authorized)
authorized
  ↓ (payment captured — may be immediate for card, delayed for bank)
paid
  ↓ (merchant/agent marks as processing)
processing
  ↓ (fulfillment provider webhook or manual mark)
fulfilled
  ↘ (at any point before fulfilled)
canceled ← refunded (from fulfilled/paid)
```

```typescript
type OrderStatus =
  | "pending"
  | "payment_pending"
  | "authorized"
  | "paid"
  | "processing"
  | "fulfilled"
  | "canceled"
  | "refunded"
  | "partial_refund";

type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded"
  | "partial_refund";

interface Order {
  orderNumber: string;                   // Human-readable, unique: ORD-2026-00001
  cartId?: string;
  userId?: string;
  customer: CustomerSnapshot;            // Frozen at checkout time
  lineItems: OrderLineItem[];            // Frozen at checkout time
  subtotal: number;
  discountCode?: string;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  total: number;
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentProviderId?: string;
  paymentProviderRef?: string;           // Provider's transaction / charge ID
  fulfillmentProviderId?: string;
  fulfillmentRef?: string;
  notes?: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface OrderLineItem {
  productId: string;
  variantId?: string;
  productName: string;                   // Snapshot — survives product deletion
  sku: string;                           // Snapshot
  qty: number;
  unitPrice: number;
  lineTotal: number;
  meta: Record<string, unknown>;
}

interface OrderEvent {
  orderId: string;
  eventType: string;                     // "status_changed" | "note_added" | "refund_initiated" | etc.
  actor: "customer" | "merchant" | "system" | "agent";
  payload: Record<string, unknown>;
  createdAt: string;
}
```

### Customer snapshot

```typescript
interface CustomerSnapshot {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  billingAddress: Address;
  shippingAddress: Address;
}

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;                       // ISO 3166-1 alpha-2
}
```

---

## 7. Storage Schema

```typescript
export const COMMERCE_STORAGE_CONFIG = {
  products: {
    indexes: [
      "status",
      "type",
      "createdAt",
      "updatedAt",
      ["status", "type"],
      ["status", "createdAt"],
    ] as const,
    uniqueIndexes: ["slug"] as const,
  },
  productVariants: {
    indexes: [
      "productId",
      "active",
      ["productId", "active"],
      ["productId", "sortOrder"],
    ] as const,
    uniqueIndexes: ["sku"] as const,
  },
  productAttributes: {
    indexes: ["sortOrder"] as const,
    uniqueIndexes: ["slug"] as const,
  },
  carts: {
    indexes: [
      "userId",
      "status",
      "expiresAt",
      "createdAt",
      ["status", "expiresAt"],
      ["userId", "status"],
    ] as const,
    uniqueIndexes: ["cartToken"] as const,
  },
  cartItems: {
    indexes: [
      "cartId",
      "productId",
      ["cartId", "productId"],
    ] as const,
  },
  orders: {
    indexes: [
      "status",
      "paymentStatus",
      "userId",
      "createdAt",
      ["status", "createdAt"],
      ["userId", "createdAt"],
      ["paymentStatus", "createdAt"],
    ] as const,
    uniqueIndexes: ["orderNumber"] as const,
  },
  orderEvents: {
    indexes: [
      "orderId",
      "createdAt",
      ["orderId", "createdAt"],
    ] as const,
  },
  providers: {
    indexes: [
      "providerType",
      "active",
      "pluginId",
      ["providerType", "active"],
    ] as const,
    uniqueIndexes: ["providerId"] as const,
  },
} satisfies PluginStorageConfig;
```

Note: `orderItems` and `orderEvents` are embedded in their parent order document
or kept as separate collections depending on expected query patterns. The schema
above treats `orderEvents` as a collection. `lineItems` are embedded in the
order document — they are immutable snapshots and are never queried independently.

---

## 8. KV Key Namespace

```typescript
export const KV_KEYS = {
  // Merchant settings (set via admin, read at request time)
  settings: {
    currency: "settings:currency:default",              // "USD"
    currencySymbol: "settings:currency:symbol",         // "$"
    taxEnabled: "settings:tax:enabled",                 // boolean
    taxDisplayMode: "settings:tax:displayMode",         // "inclusive" | "exclusive"
    shippingOriginAddress: "settings:shipping:origin",  // Address JSON
    orderNumberPrefix: "settings:order:prefix",         // "ORD"
    lowStockThreshold: "settings:inventory:lowStock",   // number
    storeEmail: "settings:store:email",
    storeName: "settings:store:name",
  },

  // Operational state (managed by the plugin, not merchant)
  state: {
    cartExpiryMinutes: "state:cart:expiryMinutes",              // default: 4320 (72h)
    checkoutWindowMinutes: "state:checkout:windowMinutes",      // default: 30
    orderNumberCounter: "state:order:numberCounter",            // monotonic counter
  },

  // Idempotency / webhook deduplication (TTL-keyed)
  webhookDedupe: (eventId: string) => `state:webhook:dedupe:${eventId}`,

  // Provider cache (invalidated when providers/register is called)
  activeProviderCache: "state:providers:cache",
} as const;
```

---

## 9. Route Contract Catalog

All routes live at `/_emdash/api/plugins/emdash-commerce/<route-name>`.

### Public routes (no auth required)

| Route | Input | Output |
|---|---|---|
| `products/list` | `{ cursor?, limit?, status?, type?, categoryId?, tag? }` | `{ items: Product[], cursor?, hasMore }` |
| `products/get` | `{ id } \| { slug }` | `Product` |
| `products/variants` | `{ productId }` | `{ variants: ProductVariant[], attributes: ProductAttribute[] }` |
| `cart/get` | `{ cartToken }` | `CartWithTotals` |
| `cart/create` | `{ currency?, cartToken? }` | `Cart` |
| `cart/add-item` | `{ cartToken, productId, variantId?, qty, meta? }` | `CartWithTotals` |
| `cart/update-item` | `{ cartToken, itemId, qty }` | `CartWithTotals` |
| `cart/remove-item` | `{ cartToken, itemId }` | `CartWithTotals` |
| `cart/apply-discount` | `{ cartToken, code }` | `CartWithTotals` |
| `cart/remove-discount` | `{ cartToken }` | `CartWithTotals` |
| `cart/shipping-rates` | `{ cartToken, destination: Address }` | `{ rates: ShippingRate[] }` — **only when shipping module enabled** |
| `cart/select-shipping` | `{ cartToken, rateId }` | `CartWithTotals` — **only when shipping module enabled** |
| `checkout/create` | `{ cartToken, customer, shippingRateId? }` | `{ orderId, orderNumber, paymentSession }` — `shippingRateId` **required** only if cart contains shippable items and the shipping module is active; otherwise omit |
| `checkout/get-order` | `{ orderNumber }` | `Order` |
| `checkout/webhook` | raw + provider signature headers | void |

### Admin routes (authenticated)

| Route | Input | Output |
|---|---|---|
| `products/create` | `ProductCreateInput` | `Product` |
| `products/update` | `{ id } & Partial<ProductCreateInput>` | `Product` |
| `products/archive` | `{ id }` | `Product` |
| `products/delete` | `{ id }` | void |
| `products/inventory-adjust` | `{ id, variantId?, delta, reason }` | `{ newStockQty }` |
| `variants/create` | `VariantCreateInput` | `ProductVariant` |
| `variants/update` | `{ id } & Partial<VariantCreateInput>` | `ProductVariant` |
| `variants/delete` | `{ id }` | void |
| `attributes/list` | `{ cursor?, limit? }` | `{ items: ProductAttribute[] }` |
| `attributes/create` | `AttributeCreateInput` | `ProductAttribute` |
| `attributes/update` | `{ id } & Partial<AttributeCreateInput>` | `ProductAttribute` |
| `orders/list` | `{ status?, cursor?, limit? }` | `{ items: Order[], cursor?, hasMore }` |
| `orders/get` | `{ id } \| { orderNumber }` | `Order` |
| `orders/update-status` | `{ id, status, note? }` | `Order` |
| `orders/add-note` | `{ id, note, visibility }` | `OrderEvent` |
| `orders/refund` | `{ id, amount, reason, lineItems? }` | `Order` |
| `providers/register` | `ProviderRegistration` | void |
| `providers/unregister` | `{ providerId }` | void |
| `providers/list` | `{ providerType? }` | `ProviderRegistration[]` |
| `settings/get` | void | `CommerceSettings` |
| `settings/update` | `Partial<CommerceSettings>` | `CommerceSettings` |
| `analytics/summary` | `{ from, to, currency? }` | `AnalyticsSummary` |
| `analytics/top-products` | `{ from, to, limit? }` | `TopProductsReport` |
| `analytics/low-stock` | `{ threshold? }` | `LowStockItem[]` |
| `ai/draft-product` | `{ description: string }` | `ProductCreateInput` |

---

## 10. Event Catalog

These are the lifecycle events our plugin records in `orderEvents` and will emit
when EmDash supports custom plugin-to-plugin hook namespaces. Extension plugins
can observe these by polling `orders/events` or by registering a webhook.

```
commerce:product:created
commerce:product:updated
commerce:product:archived
commerce:inventory:low-stock        { productId, variantId?, currentQty, threshold }
commerce:inventory:out-of-stock     { productId, variantId? }
commerce:cart:created               { cartToken, userId? }
commerce:cart:item:added            { cartToken, productId, variantId?, qty }
commerce:cart:item:updated          { cartToken, itemId, previousQty, newQty }
commerce:cart:item:removed          { cartToken, itemId }
commerce:cart:abandoned             { cartToken, userId?, itemCount, cartValue }
commerce:cart:expired               { cartToken }
commerce:checkout:started           { orderId, orderNumber, cartToken }
commerce:payment:initiated          { orderId, providerId, sessionId }
commerce:payment:authorized         { orderId, providerId, paymentRef }
commerce:payment:captured           { orderId, providerId, paymentRef, amount }
commerce:payment:failed             { orderId, providerId, reason }
commerce:order:created              { orderId, orderNumber, total, currency }
commerce:order:status:changed       { orderId, from, to, actor }
commerce:order:fulfilled            { orderId, fulfillmentRef? }
commerce:order:refunded             { orderId, amount, reason }
commerce:order:canceled             { orderId, reason }
```

Extension plugins (loyalty, email automation, analytics, fulfillment) hook into
these events. The same events power the AI agent's observability stream.

---

## 11. AI and Agent Integration Strategy

This is the primary competitive differentiator against WooCommerce and all
legacy commerce platforms. AI is not bolted on — it is an **assumed actor** in
the system design.

### Design principles for AI-first commerce

1. **Every route a human can call, an agent can call.** All admin routes use
   structured JSON input/output — no form posts, no multi-step wizards.

2. **Structured event log as truth.** `orderEvents` is the canonical audit trail.
   Agents can replay or query it. Every significant state change produces a
   structured event with `actor: "system" | "merchant" | "agent" | "customer"`.

3. **`shortDescription` on every product.** Plain text field alongside the
   Portable Text body. Embeddings, semantic search, and LLM reasoning work on
   this. The full PT body is for human reading.

4. **`meta` on every entity.** Extension data goes in `meta`. AI agents attach
   structured reasoning artifacts (e.g., `{ demand_forecast: ..., restock_at: ... }`)
   to products without touching core fields.

5. **Consistent error semantics.** Every route error includes `code` (machine-
   readable), `message` (human-readable), and `details` (structured context).
   LLMs can branch on `code` without parsing `message`.

6. **`ai/draft-product` route.** Accepts natural language: "A red leather
   wallet, $49, limited to 50 units." Returns a structured `ProductCreateInput`
   draft for merchant review and confirmation. Implemented via `ctx.http.fetch`
   to an LLM API — provider configurable in settings.

### MCP server package: `@emdash-cms/plugin-commerce-mcp`

A standard plugin that registers as a MCP server exposing commerce operations
as tools. Merchant installs it alongside the commerce plugin.

MCP tools exposed:

```
Product tools:
  list_products           → paginated product list
  get_product             → single product with variants
  create_product          → full product creation
  update_product          → partial update
  archive_product         → soft delete
  draft_product_from_ai   → NL description → draft ProductInput
  adjust_inventory        → delta adjustment with reason
  get_low_stock           → items below threshold

Order tools:
  list_orders             → paginated with filters
  get_order               → full order with line items and events
  update_order_status     → explicit status transition
  add_order_note          → merchant/agent notes
  process_refund          → full or partial
  cancel_order

Analytics tools:
  revenue_summary         → total, AOV, unit count for period
  top_products            → by revenue or units
  abandoned_cart_summary  → count, value, recovery rate

Store tools:
  get_settings
  update_settings
  list_providers          → active payment/shipping/tax providers
```

AI agents can use these tools to:
- **Bulk import** product catalogs from CSV descriptions.
- **Fulfillment automation**: mark orders fulfilled when tracking number arrives.
- **Customer service**: look up order status and issue refunds.
- **Inventory management**: restock alerts and purchase order drafts.
- **Merchandising**: draft new product listings from brief descriptions.
- **Reporting**: pull revenue snapshots on schedule.

---

## 12. Frontend Strategy

The commerce plugin ships Astro components as the canonical frontend layer.
Sites use these components directly, customize them via props, or replace them
with custom implementations backed by our API routes.

### Astro components (in `src/astro/`)

```
<ProductCard product={product} />
<ProductGrid products={products} columns={3} />
<ProductPage product={product} variants={variants} />
<VariantSelector variants={variants} attributes={attributes} onSelect={fn} />
<CartWidget />          ← floating cart icon with item count
<CartDrawer />          ← slide-in cart panel
<CartPage />            ← full cart page
<CheckoutForm order={pendingOrder} paymentSession={session} />
<OrderConfirmation order={order} />
```

These are intentionally simple, composable, and styled with CSS variables so
sites can theme them without any overrides system.

### Portable Text block types

```
product-embed       ← embed a product card inline in content
product-grid        ← curated product grid in content
buy-button          ← standalone "Add to cart" button
```

---

## 13. Phased Implementation Plan

### Phase 0 — Foundation (Step 1, detailed below)

Package scaffold, TypeScript type definitions, storage schema, KV key namespace,
route contract interfaces, provider interface contracts. No business logic yet.
This is the contracts milestone — the thing all subsequent work builds on.

**Exit criteria:** `packages/plugins/commerce` builds with TypeScript and exports
all types. No runtime code yet.

### Phase 1 — Product catalog

Public product read routes (`products/list`, `products/get`, `products/variants`).
Admin CRUD routes for products and variants. Block Kit admin pages for product
list and create/edit. Inventory adjust route. Basic search/filter on list.

**Exit criteria:** Merchant can create a simple product with variants and an
image via admin. Product is readable via public API. Inventory decrements on
direct adjustment.

### Phase 2 — Cart engine

`CartService` module (pure business logic, no I/O). Cart token strategy (signed
opaque token in cookie). All cart API routes. Cart expiry cron job. Quantity
limit validation. Price freeze on add-to-cart. Discount code validation stub.

**Exit criteria:** Frontend app can create a cart, add/update/remove items, and
retrieve totals. Cart expires after configurable TTL. Cart token round-trips
cleanly.

### Phase 3 — Provider registry

`providers/register` and `providers/unregister` routes. Provider resolution
logic (select active provider per type). Stub provider implementations for local
testing (static shipping rates, flat tax rate, mock payment). Settings admin
page for provider selection.

**Exit criteria:** Multiple payment providers can be registered and one selected
as active. The checkout flow calls the active provider. Local dev works with
stub providers.

### Phase 4 — Checkout and order creation

`checkout/create` route: validate cart → freeze price snapshot → create
`payment_pending` order → call active payment provider `initiate` route →
return payment session to frontend. `checkout/webhook` route: verify signature
→ deduplicate via KV → update order status → decrement inventory → send order
confirmation email. Order state machine guards. Idempotency on all transitions.

**Exit criteria:** Full checkout flow completes end-to-end with stub payment
provider. Real order is created, inventory decremented, confirmation email sent.

### Phase 5 — Payment providers (Stripe + Authorize.net)

Two standard plugins, both implementing `PaymentProviderContract` and registering
on `plugin:activate`:

- `@emdash-cms/plugin-commerce-stripe`
- `@emdash-cms/plugin-commerce-authorize-net`

Routes per plugin: `initiate`, `confirm`, `refund`, `webhook` (shape as required
by each gateway). Merchant selects the active payment provider in settings.

**Exit criteria:** Test-mode checkout completes with **each** provider. Order
transitions to `paid`. Refund route works for each. The shared contract is proven
by two implementations, not one.

### Phase 6 — React admin and Astro frontend

Upgrade admin from Block Kit to React (native plugin `adminEntry`). Rich product
editor (variant builder, drag-and-drop media, pricing rules). Order management
table with status transitions and refund flow. Dashboard analytics widget.
Astro components for frontend (`<ProductCard>`, `<CartDrawer>`, etc.). PT blocks
for product embeds.

**Exit criteria:** Full admin experience. Site can render a complete product
page and checkout flow using shipped Astro components.

### Phase 7 — MCP and AI tooling

`@emdash-cms/plugin-commerce-mcp` standard plugin. All MCP tools listed above.
`ai/draft-product` route in commerce core. Merchant can use an AI agent to
create products, manage orders, and pull reports.

**Exit criteria:** All listed MCP tools return correct structured data. An AI
agent can complete a product import task autonomously.

### Phase 8 — Ecosystem extensions

Shipping provider plugin (flat rate). Tax provider plugin (simple percentage,
by country/region). Reviews plugin. Wishlist plugin. Abandoned cart cron +
email automation.

---

## 14. Step 1 — Full Specification (Ready to Code)

This is the only step detailed to code-ready level. All subsequent steps are
specified once Step 1 is complete and reviewed.

### Package structure

```
packages/plugins/commerce/
├── src/
│   ├── index.ts                    # Descriptor factory (Vite / build time)
│   ├── types/
│   │   ├── product.ts              # Product discriminated union types
│   │   ├── variant.ts              # Variant and attribute types
│   │   ├── cart.ts                 # Cart and CartItem types
│   │   ├── order.ts                # Order, OrderLineItem, OrderEvent types
│   │   ├── customer.ts             # CustomerSnapshot, Address
│   │   ├── provider.ts             # Provider registration + contract interfaces
│   │   └── index.ts                # Re-export all types
│   ├── storage/
│   │   └── schema.ts               # COMMERCE_STORAGE_CONFIG + CommerceStorage type
│   ├── kv/
│   │   └── keys.ts                 # KV_KEYS typed constants
│   └── routes/
│       └── contracts.ts            # Zod schemas for all route inputs
├── package.json
└── tsconfig.json
```

### package.json

```json
{
  "name": "@emdash-cms/plugin-commerce",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./sandbox": "./src/sandbox-entry.ts",
    "./admin": "./src/admin.tsx",
    "./astro": "./src/astro/index.ts"
  },
  "peerDependencies": {
    "emdash": "^0.1.0",
    "astro": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "zod": "^3.22.0"
  }
}
```

### `src/index.ts` — descriptor factory (skeleton)

At Step 1, this file only defines the descriptor. No routes, no hooks yet.

```typescript
import type { PluginDescriptor } from "emdash";
import { COMMERCE_STORAGE_CONFIG } from "./storage/schema.js";

export interface CommercePluginOptions {
  currency?: string;
  taxIncluded?: boolean;
}

export function commercePlugin(
  options: CommercePluginOptions = {},
): PluginDescriptor<CommercePluginOptions> {
  return {
    id: "emdash-commerce",
    version: "0.1.0",
    entrypoint: "@emdash-cms/plugin-commerce/sandbox",
    adminEntry: "@emdash-cms/plugin-commerce/admin",
    componentsEntry: "@emdash-cms/plugin-commerce/astro",
    options,
    capabilities: [
      "network:fetch",   // payment gateway, shipping, tax, fulfillment APIs
      "email:send",      // order confirmations, abandoned cart, notifications
      "read:users",      // link orders to authenticated users
      "read:media",      // read product media
      "write:media",     // upload product media
    ],
    allowedHosts: [
      // Narrowed at runtime via settings. Stub wildcard for dev.
      // Phase 5 narrows to specific gateway hosts.
      "*",
    ],
    storage: COMMERCE_STORAGE_CONFIG,
    adminPages: [
      { path: "/products", label: "Products", icon: "tag" },
      { path: "/orders", label: "Orders", icon: "shopping-cart" },
      { path: "/settings", label: "Commerce Settings", icon: "settings" },
    ],
    adminWidgets: [
      { id: "commerce-kpi", title: "Store Overview", size: "full" },
    ],
  };
}
```

### `src/storage/schema.ts`

See Section 7 above — implement verbatim.

### `src/kv/keys.ts`

See Section 8 above — implement verbatim.

### `src/types/product.ts`

See Section 5 above — implement verbatim.

### `src/types/cart.ts`

See Section 6 (Cart) above — implement verbatim.

### `src/types/order.ts`

See Section 6 (Order) above — implement verbatim.

### `src/types/provider.ts`

```typescript
export type ProviderType = "payment" | "shipping" | "tax" | "fulfillment";

export interface ProviderRegistration {
  providerId: string;                    // e.g., "stripe-v1"
  providerType: ProviderType;
  displayName: string;                   // e.g., "Stripe"
  pluginId: string;                      // e.g., "emdash-commerce-stripe"
  routeBase: string;                     // e.g., "/_emdash/api/plugins/emdash-commerce-stripe"
  active: boolean;
  config: Record<string, unknown>;       // Provider-specific (non-secret) config
  registeredAt: string;
}

// Payment provider contract
export interface PaymentInitiateRequest {
  orderId: string;
  orderNumber: string;
  total: number;                         // Cents
  currency: string;
  customer: import("./customer.js").CustomerSnapshot;
  lineItems: import("./order.js").OrderLineItem[];
  successUrl: string;
  cancelUrl: string;
  meta?: Record<string, unknown>;
}

export interface PaymentInitiateResponse {
  sessionId: string;
  redirectUrl?: string;                  // For redirect-based flows (PayPal, etc.)
  clientSecret?: string;                 // For embedded flows (Stripe Elements)
  expiresAt: string;
}

export interface PaymentConfirmRequest {
  sessionId: string;
  orderId: string;
  rawWebhookPayload: unknown;
  rawWebhookHeaders: Record<string, string>;
}

export interface PaymentConfirmResponse {
  success: boolean;
  paymentRef: string;
  amountCaptured: number;
  currency: string;
  failureReason?: string;
}

export interface PaymentRefundRequest {
  orderId: string;
  paymentRef: string;
  amount: number;
  reason: string;
}

export interface PaymentRefundResponse {
  success: boolean;
  refundRef: string;
  amountRefunded: number;
}

// Shipping provider contract
export interface ShippingRateRequest {
  items: Array<{
    productId: string;
    variantId?: string;
    qty: number;
    weight?: number;                     // grams
  }>;
  origin: import("./customer.js").Address;
  destination: import("./customer.js").Address;
  currency: string;
}

export interface ShippingRate {
  rateId: string;
  carrier: string;
  service: string;
  displayName: string;
  price: number;
  estimatedDays?: number;
  meta?: Record<string, unknown>;
}

// Tax provider contract
export interface TaxCalculationRequest {
  items: Array<{
    productId: string;
    variantId?: string;
    qty: number;
    unitPrice: number;
    taxClass?: string;
  }>;
  billingAddress: import("./customer.js").Address;
  shippingAddress: import("./customer.js").Address;
  currency: string;
}

export interface TaxCalculationResponse {
  totalTax: number;
  breakdown: Array<{
    label: string;
    rate: number;
    amount: number;
  }>;
}
```

### `src/routes/contracts.ts`

Define Zod schemas for the public and admin route inputs catalogued in Section
9. These are used in Phase 1 and beyond. At Step 1, define them as commented
stubs so the shapes are locked, even without handler implementations.

Pattern: one Zod schema per route, named `<routeName>Schema`. One inferred type
export per schema, named `<RouteName>Input`.

```typescript
import { z } from "astro/zod";
import type { infer as ZInfer } from "astro/zod";

// ─── Shared ──────────────────────────────────────────────────────

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().length(2),        // ISO 3166-1 alpha-2
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

// ─── Products ────────────────────────────────────────────────────

export const productListSchema = paginationSchema.extend({
  status: z.enum(["draft", "active", "archived"]).optional(),
  type: z.enum(["simple", "variable", "bundle", "digital", "gift_card"]).optional(),
  categoryId: z.string().optional(),
  tag: z.string().optional(),
});

export const productGetSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ slug: z.string().min(1) }),
]);

export const productCreateSchema = z.object({
  type: z.enum(["simple", "variable", "bundle", "digital", "gift_card"]),
  name: z.string().min(1).max(500),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  descriptionBlocks: z.array(z.unknown()).optional(),
  shortDescription: z.string().max(500).optional(),
  basePrice: z.number().int().min(0),
  compareAtPrice: z.number().int().min(0).optional(),
  currency: z.string().length(3).default("USD"),
  mediaIds: z.array(z.string()).default([]),
  categoryIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(500).optional(),
  typeData: z.record(z.unknown()),
});

export const inventoryAdjustSchema = z.object({
  id: z.string().min(1),
  variantId: z.string().optional(),
  delta: z.number().int(),              // positive = restock, negative = correction
  reason: z.string().min(1),
});

// ─── Cart ────────────────────────────────────────────────────────

export const cartCreateSchema = z.object({
  currency: z.string().length(3).optional(),
  cartToken: z.string().optional(),     // Resume existing cart
});

export const cartGetSchema = z.object({
  cartToken: z.string().min(1),
});

export const cartAddItemSchema = z.object({
  cartToken: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().optional(),
  qty: z.number().int().min(1).max(999),
  meta: z.record(z.unknown()).optional(),
});

export const cartUpdateItemSchema = z.object({
  cartToken: z.string().min(1),
  itemId: z.string().min(1),
  qty: z.number().int().min(0).max(999), // 0 = remove
});

export const cartRemoveItemSchema = z.object({
  cartToken: z.string().min(1),
  itemId: z.string().min(1),
});

export const cartApplyDiscountSchema = z.object({
  cartToken: z.string().min(1),
  code: z.string().min(1).max(100),
});

export const cartShippingRatesSchema = z.object({
  cartToken: z.string().min(1),
  destination: addressSchema,
});

export const cartSelectShippingSchema = z.object({
  cartToken: z.string().min(1),
  rateId: z.string().min(1),
});

// ─── Checkout ────────────────────────────────────────────────────

const customerSnapshotSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
});

export const checkoutCreateSchema = z.object({
  cartToken: z.string().min(1),
  customer: customerSnapshotSchema,
  /** Required when shipping module is active and cart has shippable items */
  shippingRateId: z.string().min(1).optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  meta: z.record(z.unknown()).optional(),
});

// ─── Orders ──────────────────────────────────────────────────────

export const orderListSchema = paginationSchema.extend({
  status: z.enum([
    "pending", "payment_pending", "authorized", "paid",
    "processing", "fulfilled", "canceled", "refunded", "partial_refund",
  ]).optional(),
  userId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const orderUpdateStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "processing", "fulfilled", "canceled", "refunded", "partial_refund",
  ]),
  note: z.string().optional(),
  actor: z.enum(["merchant", "agent"]).default("merchant"),
});

export const orderRefundSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().min(1),
  reason: z.string().min(1),
  lineItems: z.array(z.object({
    lineItemIndex: z.number().int().min(0),
    qty: z.number().int().min(1),
  })).optional(),
});

// ─── Providers ───────────────────────────────────────────────────

export const providerRegisterSchema = z.object({
  providerId: z.string().min(1).regex(/^[a-z0-9-]+$/),
  providerType: z.enum(["payment", "shipping", "tax", "fulfillment"]),
  displayName: z.string().min(1),
  pluginId: z.string().min(1),
  routeBase: z.string().url(),
  config: z.record(z.unknown()).default({}),
});

// ─── Type Exports ────────────────────────────────────────────────

export type ProductListInput = ZInfer<typeof productListSchema>;
export type ProductCreateInput = ZInfer<typeof productCreateSchema>;
export type InventoryAdjustInput = ZInfer<typeof inventoryAdjustSchema>;
export type CartCreateInput = ZInfer<typeof cartCreateSchema>;
export type CartAddItemInput = ZInfer<typeof cartAddItemSchema>;
export type CartUpdateItemInput = ZInfer<typeof cartUpdateItemSchema>;
export type CheckoutCreateInput = ZInfer<typeof checkoutCreateSchema>;
export type OrderListInput = ZInfer<typeof orderListSchema>;
export type OrderUpdateStatusInput = ZInfer<typeof orderUpdateStatusSchema>;
export type OrderRefundInput = ZInfer<typeof orderRefundSchema>;
export type ProviderRegisterInput = ZInfer<typeof providerRegisterSchema>;
```

### `src/types/index.ts`

```typescript
export type * from "./product.js";
export type * from "./variant.js";
export type * from "./cart.js";
export type * from "./order.js";
export type * from "./customer.js";
export type * from "./provider.js";
```

### Step 1 exit criteria

1. `packages/plugins/commerce` exists and builds without TypeScript errors.
2. All types from Section 5 and 6 are exported.
3. All Zod schemas from the route contract catalog are defined and typed.
4. The storage schema `satisfies PluginStorageConfig` without errors.
5. The descriptor factory `commercePlugin()` returns a valid `PluginDescriptor`.
6. No business logic exists yet — this milestone is purely contracts.

---

## 15. Product decisions (locked) + small defaults

**Where this section lives:** Section 15 is the **last** section of this document.
Section 14 (“Step 1 — Full Specification”) is very long; if you only scrolled partway
through Step 1, keep scrolling to the file end to reach Section 15.

### Locked decisions (your answers)

1. **Payment providers (v1)**  
   Support **Stripe** and **Authorize.net** from the first shipping release of
   payments — not a single-provider MVP. The provider registry and
   `PaymentProviderContract` must be validated against **two** real gateways early
   (Phase 5 becomes “Stripe + Authorize.net”, not Stripe-only).

2. **Inventory: payment-first, reserve-at-finalize**  
   Do **not** hold stock when the customer adds to cart or when checkout starts.
   **Re-validate availability and decrement inventory only after successful
   payment** (or at the same atomic transition that marks the order paid —
   whichever the storage model allows without double-sell).  
   **UX implication:** Between “add to cart” and “payment succeeded”, counts can
   change. The API must return **clear, machine-readable error codes** (e.g.
   `inventory_changed`, `insufficient_stock`) and copy-ready **human messages** so
   the storefront can explain: *“While you were checking out, availability for one
   or more items changed.”*

3. **Tax and shipping as a separate module**  
   Without the **fulfillment / shipping & tax** module installed and active:
   - No **shipping address** capture and no **shipping quote** flows in core UI or
     public API (those routes either are absent or return a consistent
     `feature_not_enabled` / 404 — pick one policy and document it).
   - Core checkout may assume **no shippable line items** or a merchant-configured
     “digital / no shipping” mode; physical goods that need a quote **require** the
     module.  
   **Multi-currency and localized tax rules** are **in scope for that same module
   family** (not in commerce core v1), so currency display, conversion, and
   region-specific tax live there or behind additional providers — not duplicated
   in core.

4. **Authenticated purchase history + cart across sessions and devices**  
   Logged-in users must have:
   - **Purchase history** (orders linked to `userId`).
   - **Cart continuity** when they log out and back in, or open another client:
     server-side cart bound to `userId` (with optional merge from anonymous
     `cartToken` on login).  
   Anonymous browsing may still use `cartToken`; **login associates or merges**
   into the durable user cart.

### Small defaults (still open to tweak, low risk)

- **Order number format:** `ORD-YYYY-NNNNN` (human-readable; separate from storage
  document id) unless you prefer opaque IDs for customer-facing URLs.
- **Tax display when tax module is off:** N/A — tax lines appear only when a tax
  provider/module is active.
