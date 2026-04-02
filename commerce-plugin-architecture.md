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
- **Type-safe contracts.** The SDK package exports Zod schemas matching the
  interfaces. Extension plugin authors get compile-time safety.
- **Multiple providers, one active.** The registry supports multiple registered
  providers per type. The merchant selects the active one in admin settings.
  Fallback behavior is defined per type.

### Provider execution model — two modes, one contract

The contract interface is identical in both modes. **Execution mode** depends on
how the provider plugin is installed:

| Mode | When | How the core calls the provider |
|------|------|---------------------------------|
| **In-process adapter** | Plugin installed as trusted (in-process, `plugins: []`) | Direct TypeScript function call. No HTTP. No subrequest. |
| **Route delegation** | Plugin installed as sandboxed (`sandboxed: []`) or across isolate boundary | Core calls `ctx.http.fetch` to the provider's plugin route. Required by the EmDash sandbox model — the only permitted cross-isolate boundary. |

**Default rule:** First-party provider plugins (Stripe, Authorize.net) run as
trusted in-process adapters. External API calls (to Stripe/Authorize.net APIs)
happen **inside** the provider adapter using `ctx.http.fetch` — not in the core
checkout path. Route delegation is reserved for genuinely sandboxed or
marketplace-distributed extensions.

This preserves the contract model, removes unnecessary faux-network indirection
from the core checkout path, and keeps local dev and testing simple.

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
  publishedAt?: string;                  // When first made active; null = never published
  descriptionBlocks?: unknown[];          // Portable Text
  shortDescription?: string;             // Plain text summary (for AI/search/embeddings)
  searchText?: string;                   // Denormalized: name + sku + tags for full-text queries
  basePrice: number;                     // Cents / smallest currency unit
  compareAtPrice?: number;               // Strike-through price
  currency: string;                      // ISO 4217
  mediaIds: string[];                    // References to ctx.media
  categoryIds: string[];
  tags: string[];
  requiresShipping: boolean;             // false for digital, gift cards; affects checkout flow
  taxCategory?: string;                  // For tax module: "standard" | "reduced" | "zero" | custom
  defaultVariantId?: string;             // For variable products: pre-selected variant on product page
  seoTitle?: string;
  seoDescription?: string;
  typeData: Record<string, unknown>;     // Validated per type in handlers
  meta: Record<string, unknown>;         // Extension plugins store data here; not a junk drawer
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
  inventoryVersion: number;              // Monotonic counter; used in finalize-time optimistic check
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
type CartStatus =
  | "active"      // In use; items can be added/removed
  | "merged"      // Anonymous cart merged into a logged-in user's cart on login
  | "abandoned"   // No activity for configured TTL; cron marks it; triggers recovery flow
  | "converted"   // Checkout completed; order created from this cart
  | "expired";    // Past expiresAt without conversion or abandonment action

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

Allowed transitions only. Handlers must reject any transition not in this table.

```
draft
  ↓  checkout.create called
payment_pending
  ↓  gateway webhook: authorized (auth-only flow, e.g. Authorize.net)
authorized
  ↓  gateway webhook: captured (immediate for Stripe card; delayed for bank ACH)
  ↓  (from payment_pending direct, for gateways with no separate auth step)
paid
  ↓  merchant/agent marks processing
processing
  ↓  fulfillment webhook or manual mark
fulfilled

From any pre-fulfilled state:
  → canceled      (before payment_pending: no gateway action needed)
  → canceled      (from authorized: void must be called on gateway first)

From paid / fulfilled:
  → refund_pending  (refund initiated, awaiting gateway confirmation)
  → refunded        (gateway confirmed full refund)
  → partial_refund  (gateway confirmed partial refund)

Exceptional:
  → payment_conflict  (payment succeeded at gateway but inventory finalize failed;
                       requires manual resolution or auto-void/refund)
```

```typescript
type OrderStatus =
  | "draft"             // Order record created; payment not yet initiated
  | "payment_pending"   // Payment session initiated; awaiting gateway event
  | "authorized"        // Payment authorized but not yet captured (auth+capture flows)
  | "paid"              // Payment captured; inventory decremented
  | "processing"        // Paid; merchant/fulfillment is preparing the shipment
  | "fulfilled"         // Shipped or delivered; order complete
  | "canceled"          // Canceled before/without successful payment
  | "refund_pending"    // Refund initiated; awaiting gateway confirmation
  | "refunded"          // Fully refunded
  | "partial_refund"    // Partially refunded
  | "payment_conflict"; // Payment succeeded but finalization failed; needs resolution

type PaymentStatus =
  | "requires_action"   // Awaiting customer action (3DS, redirect, bank confirmation)
  | "pending"           // Submitted to gateway; no confirmation yet
  | "authorized"        // Authorized but not captured
  | "captured"          // Funds captured (equivalent to "paid" at payment level)
  | "failed"            // Gateway rejected or timed out
  | "voided"            // Authorization canceled before capture
  | "refund_pending"    // Refund in flight
  | "refunded"          // Fully refunded
  | "partial_refund";   // Partially refunded

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

  // Append-only ledger of every inventory movement. stockQty is derived from this.
  // Never update or delete rows; always insert a new record.
  inventoryLedger: {
    indexes: [
      "productId",
      "variantId",
      "referenceType",
      "referenceId",
      "createdAt",
      ["productId", "createdAt"],
      ["variantId", "createdAt"],
    ] as const,
  },

  // One record per payment attempt, regardless of outcome.
  paymentAttempts: {
    indexes: [
      "orderId",
      "providerId",
      "status",
      "createdAt",
      ["orderId", "status"],
      ["providerId", "createdAt"],
    ] as const,
  },

  // Deduplicated log of every inbound webhook. Used for idempotency and replay detection.
  webhookReceipts: {
    indexes: [
      "providerId",
      "externalEventId",
      "orderId",
      "status",
      "createdAt",
      ["providerId", "externalEventId"],
    ] as const,
    uniqueIndexes: ["externalEventId"] as const,
  },

} satisfies PluginStorageConfig;
```

### Storage design notes

- `lineItems` are **embedded** in the order document — immutable snapshots, never queried independently.
- `orderEvents` is a **separate collection** — append-only; supports order timeline queries.
- `inventoryLedger` is **append-only**. The `stockQty` field on `products`/`productVariants` is a materialized cache updated atomically with each ledger insert. Never mutate stock directly — always write a ledger record and derive the new count.
- `webhookReceipts.externalEventId` is the provider's event/charge/transfer ID. The unique index is the deduplication guard; insert fails if already seen → idempotency enforced at storage layer.
- `paymentAttempts` enables refund reconciliation, retry auditing, and support escalation without relying solely on the payment provider's dashboard.

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

The original phase plan was too broad too early. The revised plan below:
- Freezes dangerous semantics before coding starts (Phase 0)
- Proves one complete real flow before expanding (Phases 1–3)
- Validates the provider abstraction with a second gateway before growing the ecosystem (Phase 4)
- Expands UI, AI tooling, and extensions only after correctness is proven (Phases 5–7)

### Phase 0 — Semantic hardening + contracts (Step 1 spec, see Section 14)

Package scaffold. TypeScript types. Storage schema. KV namespace. Route contracts
(Zod schemas). Provider interface contracts. State machine constants. Error
catalog constants. **No business logic yet.**

**Exit criteria:**
- `packages/plugins/commerce` builds with TypeScript; exports all types and schemas.
- State machine transition tables are in code as constants (not just docs).
- Error catalog is in code as a typed `const` object.
- Inventory ledger, payment attempt, and webhook receipt types are defined.
- No runtime logic exists yet; this milestone is purely contracts.

### Phase 1 — Commerce kernel (Layer A, no UI)

Pure domain logic with no admin, no Astro, no React, no MCP. Enforced by
directory structure (`src/kernel/`). All business functions are pure or take
explicit I/O dependencies via injection — no direct `ctx.*` calls inside kernel.

Scope:
- Simple product domain rules and validation.
- Cart service: create, add item, update qty, remove, totals, expiry.
- Inventory service: `adjustStock(delta, reason, referenceType, referenceId)` — writes ledger + updates qty atomically.
- Order snapshot creation from cart.
- `finalizePayment(orderId, paymentRef)` — the single authoritative finalization path:
  1. Check idempotency (`webhookReceipts.externalEventId`).
  2. Verify order is in `payment_pending` or `authorized`.
  3. Read variant `inventoryVersion` at time of cart snapshot vs current — if changed and stock now insufficient, transition order to `payment_conflict` and return `insufficient_stock`.
  4. Decrement stock, insert ledger row.
  5. Transition order to `paid`, payment to `captured`.
  6. Emit side effects (email, events) **after** the above succeeds.
- Error types using the catalog (Section 16).
- Domain event records for `orderEvents`.

**Exit criteria:**
- All kernel functions are pure / injected; zero `ctx.*` imports inside `src/kernel/`.
- `finalizePayment` is idempotent (calling twice with same `externalEventId` is a no-op).
- Tests cover: duplicate finalize, stock-change conflict, stale cart, state transition guards.

### Phase 2 — One real vertical slice (Stripe + EmDash plugin wrapper)

One complete purchase flow, end-to-end:
- View a simple product (public `products/get` route).
- Add to cart, view cart, update/remove items (cart routes).
- Checkout start: create `draft` order, initiate Stripe Payment Intent.
- Stripe webhook: verify signature → idempotency check → call `finalizePayment`.
- Order visible in admin (Block Kit order list page).
- Order timeline (`orderEvents`) visible in admin for debugging.
- Order confirmation email.

EmDash plugin wrapper (`src/plugin/`): descriptor, `definePlugin`, routes wiring
into kernel, `ctx.storage` as the I/O layer, `ctx.kv`, `ctx.email`, `ctx.http`.

Storefront: one minimal Astro page per step (product, cart, checkout, confirmation).
No `<CartDrawer>` component library yet — that is Phase 5. Goal: prove the flow,
not ship a UI framework.

**Exit criteria:**
- A test customer can buy a real simple product in Stripe test mode, end to end.
- Order finalizes correctly. Inventory decrements. Email sends.
- Duplicate Stripe webhook does not double-decrement stock.
- Inventory conflict path returns structured `payment_conflict` order + initiates auto-void.

### Phase 3 — Hardening before features

No new features. Pressure-test Phase 2 against expected failure cases:

Required tests added in this phase:
- Duplicate webhook (same `externalEventId`).
- Retry after webhook timeout (second delivery after first partially processed).
- Inventory changed between cart creation and finalize.
- Cart expired before checkout.create.
- Payment success + inventory failure → `payment_conflict` → auto-void triggered.
- Order finalization idempotency (repeated callback replay).
- Cancellation and refund state transition guards (invalid transitions rejected).
- Stale cart reuse after TTL.

If the architecture bends under these tests, fix it before Phase 4.

**Exit criteria:** All failure cases above have passing tests. No architectural
regressions from fixing them.

### Phase 4 — Authorize.net (validate provider abstraction)

Add `@emdash-cms/plugin-commerce-authorize-net` as a second in-process provider
adapter. The goal is not feature breadth — it is to prove that the
`PaymentProviderContract` is truly gateway-agnostic.

Authorize.net introduces explicit auth/capture separation, which is why `authorized`
is a required order state (and was not removed from the state machine despite the
reviewer's suggestion).

**Exit criteria:**
- Test-mode checkout completes with Authorize.net.
- Auth-only flow (authorize → captured later) works through the existing state machine.
- No branching in kernel code for Stripe vs Authorize.net — all differences are in adapters.
- Refund route works for both gateways.

### Phase 5 — Admin UX expansion

Replace Block Kit admin with React (native plugin `adminEntry`):
- Rich product editor (variant builder, image upload, pricing).
- Order management table with status transitions, notes, refund flow.
- Merchant settings page (provider selection, store config).
- KPI dashboard widget (revenue, open orders, low stock).
- Logged-in user purchase history page.

**Exit criteria:** Merchant can perform all common operations (product CRUD,
order management, refund) without touching the API directly.

### Phase 6 — Storefront and extensions

After correctness is proven and admin is stable:
- Full Astro component library (`<ProductCard>`, `<CartDrawer>`, `<CheckoutForm>`, etc.).
- Portable Text blocks for product embeds.
- Variable product support (variant selector).
- Shipping/tax module (separate plugin family; see §15 decisions).
- Abandoned cart cron + email recovery.
- Digital product downloads.

### Phase 7 — AI/MCP surfaces

`@emdash-cms/plugin-commerce-mcp` standard plugin. `ai/draft-product` route.
All MCP tools from Section 11. Merchant can use an AI agent for product import,
order management, inventory management, and reporting.

**Do not do this before Phase 3 hardening is complete.** AI agent reliability
depends on consistent structured errors and idempotent operations — those must
be proven before surfaces are exposed.

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

---

## 16. Error Catalog

Every route error must use this structure:

```typescript
interface CommerceError {
  code: CommerceErrorCode;       // Machine-stable; safe for AI branching
  message: string;               // Human-readable; safe to display
  httpStatus: number;
  retryable: boolean;            // Whether the client may safely retry
  details?: Record<string, unknown>; // Structured context (e.g. which itemId, which field)
}
```

### Canonical error codes

```typescript
export const COMMERCE_ERRORS = {
  // Inventory
  INVENTORY_CHANGED:          { httpStatus: 409, retryable: false },
  INSUFFICIENT_STOCK:         { httpStatus: 409, retryable: false },

  // Product / catalog
  PRODUCT_UNAVAILABLE:        { httpStatus: 404, retryable: false },
  VARIANT_UNAVAILABLE:        { httpStatus: 404, retryable: false },

  // Cart
  CART_NOT_FOUND:             { httpStatus: 404, retryable: false },
  CART_EXPIRED:               { httpStatus: 410, retryable: false },
  CART_EMPTY:                 { httpStatus: 422, retryable: false },

  // Order
  ORDER_NOT_FOUND:            { httpStatus: 404, retryable: false },
  ORDER_STATE_CONFLICT:       { httpStatus: 409, retryable: false },
  PAYMENT_CONFLICT:           { httpStatus: 409, retryable: false },

  // Payment
  PAYMENT_INITIATION_FAILED:  { httpStatus: 502, retryable: true },
  PAYMENT_CONFIRMATION_FAILED:{ httpStatus: 502, retryable: false },
  PAYMENT_ALREADY_PROCESSED:  { httpStatus: 409, retryable: false },
  PROVIDER_UNAVAILABLE:       { httpStatus: 503, retryable: true },

  // Webhooks
  WEBHOOK_SIGNATURE_INVALID:  { httpStatus: 401, retryable: false },
  WEBHOOK_REPLAY_DETECTED:    { httpStatus: 200, retryable: false }, // 200 — tell provider we got it

  // Discounts / coupons
  INVALID_DISCOUNT:           { httpStatus: 422, retryable: false },
  DISCOUNT_EXPIRED:           { httpStatus: 410, retryable: false },

  // Features / config
  FEATURE_NOT_ENABLED:        { httpStatus: 501, retryable: false },
  CURRENCY_MISMATCH:          { httpStatus: 422, retryable: false },
  SHIPPING_REQUIRED:          { httpStatus: 422, retryable: false },
} as const satisfies Record<string, { httpStatus: number; retryable: boolean }>;

export type CommerceErrorCode = keyof typeof COMMERCE_ERRORS;
```

Rules:
- `WEBHOOK_REPLAY_DETECTED` returns **200** (not 4xx) so that payment gateways do
  not retry the delivery — they treat non-2xx as failures and retry aggressively.
- `PAYMENT_CONFLICT` is used when payment captured but inventory finalize failed.
  It is distinct from `INSUFFICIENT_STOCK` because money has moved.
- All codes are **snake_case strings**, stable across versions; never remove a
  code, only add.

---

## 17. Cart Merge Rules

Applies when a user with an anonymous `cartToken` logs in and may have a
pre-existing server-side cart linked to their `userId`.

### Guest checkout policy

Guest checkout (purchase without creating an account) is **supported**. Orders
are linked to `userId: null` and the `customer.email` is the only persistent
identifier. Guest orders can be associated with a new/existing account by email
match — see below.

### Merge algorithm on login

1. **Identify carts**: Look up the anonymous cart by `cartToken` (source) and any
   `active` or `abandoned` cart owned by `userId` (target).

2. **If no target cart exists**: Claim the anonymous cart by setting `userId` on
   it. Status stays `active`. No merge needed.

3. **If both carts exist and both have items**:
   - For each item in the source cart:
     - If the same `productId` + `variantId` already exists in target: **add quantities** (source qty + target qty), capped at product `maxQty` or 999.
     - If the item does not exist in target: **copy item** into target.
   - Validate all merged items against current availability (product `active`, variant
     `active`, price not drastically changed). Items that fail validation are removed
     and reported back to the caller in the merge response so the frontend can show a
     notice.
   - Transition source cart to `merged`.

4. **If source cart is empty**: Discard it (transition to `expired`); use target.

5. **If target cart is empty**: Claim the source cart (set `userId`; transition
   source cart to active under the user). Discard empty target.

### Invalid merged items

If a merged line item references an unavailable product or variant, it is silently
removed with an entry in the merge response under `removedItems: [{ productId, reason }]`.
The frontend should display a notice.

### Past orders ↔ account association

If a guest places an order and later creates an account with the same email:
- The `orders/list` route, when called by an authenticated user, also queries
  for guest orders matching `customer.email`. These are returned in purchase
  history with a flag `guestOrder: true`.
- **We do not automatically rewrite `order.userId`** on the historical record.
  Association is read-time only, so there is no risk of corrupting audit trails.

---

## 18. Layer Boundaries

Code must be organized into four layers. **No layer may import from a higher
layer.** Violations should be caught by lint rules (e.g. `eslint-plugin-import`
`no-restricted-paths`).

```
Layer A — Commerce Kernel   (src/kernel/)
  ↑ no dependencies on B, C, D
  Pure domain: types, state machines, error catalog, cart service,
  inventory service, order service, finalization function, totals.
  No ctx.*, no HTTP, no React, no Astro.

Layer B — EmDash Plugin Wrapper   (src/plugin/)
  ↑ depends on A only
  Plugin descriptor (index.ts), definePlugin (sandbox-entry.ts),
  route handlers, ctx.* wiring, storage adapters, hook handlers.

Layer C — Admin UI   (src/admin/)
  ↑ depends on B (via route calls or SDK) and A (for types)
  React components, Block Kit JSON builders, admin pages, widgets.
  No direct ctx.* access.

Layer D — Storefront UI   (src/astro/)
  ↑ depends on A (for types), calls Layer B routes via HTTP
  Astro components, page templates, checkout flow UI.
  No kernel imports except shared types.
```

**Practical rule for v1:** A single `packages/plugins/commerce` package is
acceptable. Enforce the layers through **directory structure and enforced import
rules**, not separate npm packages (that can come later when needed).

---

## 19. Observability Requirements

Observability is not a post-launch concern. The first gateway integration must
be debuggable from day one.

### Mandatory from Phase 2

- **Correlation ID**: Every request that enters the checkout flow generates a
  `correlationId` (uuid). It is threaded through every `ctx.log.*` call, every
  `orderEvent` record, and every `paymentAttempt` record. It is returned in error
  responses under `details.correlationId`.

- **Order timeline**: Every state transition appends a record to `orderEvents`
  with: `eventType`, `fromState`, `toState`, `actor`, `correlationId`, `createdAt`,
  and optional `payload` (non-sensitive context only — no card numbers, no secrets).

- **Provider call log**: Every outbound call to a payment gateway or provider route
  appends a `paymentAttempt` record with: `providerId`, `action`
  (initiate/confirm/refund/webhook), `status`, `durationMs`, `correlationId`,
  `createdAt`. Sensitive fields (raw payload, response body) are **redacted** —
  store only a hash or omit entirely.

- **Webhook receipt log**: Every inbound webhook appends a `webhookReceipt` record
  with: `providerId`, `externalEventId`, `orderId`, `status`
  (processed/duplicate/invalid_signature/error), `createdAt`. Raw body is **not
  stored** — only the normalized, validated facts.

- **Inventory mutation log**: Every stock change is a row in `inventoryLedger`.
  `reason` and `referenceType`/`referenceId` are mandatory — never allow `reason:
  "unknown"`.

- **Actor attribution**: Every `orderEvent` records `actor` as one of:
  `"customer"` | `"merchant"` | `"system"` | `"agent"`. AI agent operations are
  always tagged `"agent"` so audit trails distinguish machine from human actions.

- **Structured log levels**: Use `ctx.log.info / warn / error` with a consistent
  shape: `{ correlationId, orderId?, cartId?, event, ...context }`. Never log
  secrets, PII beyond email, or raw payment payloads.
