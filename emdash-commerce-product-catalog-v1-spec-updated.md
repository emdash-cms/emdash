# EmDash Commerce Product Catalog v1 Specification

## Document purpose

This document defines the **v1 product catalog schema and implementation plan** for the EmDash commerce plugin. It is written as a build-ready specification for the developer. The goal is to create a clean, durable product model that supports:

- simple physical products,
- simple digital/downloadable products,
- variable products,
- fixed bundles composed of SKU-level components,
- mixed physical + digital fulfillment,
- product images and galleries,
- future-safe storage abstraction,
- order-line historical accuracy via snapshots.

This spec is intentionally **practical, explicit, and staged**. It is designed to reduce ambiguity, prevent over-engineering, and give the developer a clear build order.

---

## Core principles

### 1. Sellable units must be modeled consistently

Every product must have **one or more SKU records**.

That means:

- a **simple product** has exactly **one SKU**
- a **variable product** has **multiple SKU variants**
- a **bundle** is a **sellable record** whose components reference underlying SKU records

Do **not** mix models where sometimes the product itself is purchasable and sometimes only variants are purchasable. That creates downstream complexity in inventory, pricing, order lines, and bundle composition.

### 2. The product record is not the inventory record

The product is the catalog/container record.

The SKU is the sellable unit and should own the fields that differ at the sellable level, such as:

- SKU code
- price
- compare-at price
- cost (optional but recommended)
- inventory quantity
- barcode/GTIN/UPC
- weight and dimensions
- fulfillment behavior when SKU-specific
- variant option values

### 3. Bundles must be SKU-derived, not stock-owned

Bundles do **not** have independent inventory.

Bundle stock must be derived from the availability of the component SKUs. When a bundle sells, inventory is decremented from the component SKU rows.

### 4. Historical order accuracy must not depend on live catalog rows

Orders must store **snapshots** of what was purchased at checkout time.

Order lines may keep `product_id` or `sku_id` references for convenience, but those live references must **not** be treated as the authoritative historical record.

### 5. Physical + digital should not always be modeled as a bundle

A physical product may include access to one or more digital assets, such as:

- a manual
- a PDF pattern
- setup instructions
- bonus download

This should be supported through **digital entitlements / digital attachments** linked to the purchased SKU. Do not force every physical+digital combination into a formal bundle model.

### 6. Storage must be abstracted

For product images and digital files, do not bake in local filesystem assumptions.

Store provider-neutral asset metadata so storage can move later from local disk to cloud/object storage with minimal schema churn.

### 7. Align with EmDash's typed collections and media model

This schema must align with EmDash's apparent platform model:

- commerce entities such as products, SKUs, attributes, bundles, and category relationships should be modeled as **typed commerce collections/tables**
- images and downloadable files should be modeled as **media/file assets**, not as disguised product/content rows
- product-to-file relationships should be explicit links/references, not a WordPress-style "everything is one generic record" approach

Practical rules for the developer:

- do **not** model product images or downloads as generic product/content records
- do **not** make file storage paths the primary product-owned truth
- do **not** assume a WordPress-style universal `posts` table or attachment model

Instead:

- create explicit commerce entities for catalog data
- create explicit asset/media records for files
- link products/SKUs to assets through relation records
- keep file/storage metadata provider-neutral so local storage can later move to cloud storage with minimal redesign

### 8. Upload flow must be asset-first, then product-linking

The product/file flow should be designed as:

1. create or upload media asset
2. receive asset/media identifier
3. link asset to product or SKU
4. use that relation in storefront/admin retrieval

Do not design the catalog API around sending binary file payloads inside product create/update requests unless EmDash explicitly requires that later. The safer default is asset-first upload, then relational linking.

---

## Supported v1 product capabilities

The catalog must support the following:

1. **Simple physical product**
   - shipped to the customer
   - one sellable SKU
   - may have one or more product images
   - may optionally include one or more digital entitlements

2. **Simple digital/downloadable product**
   - no shipping required
   - one sellable SKU
   - may reference one or more downloadable files
   - may enforce download rules

3. **Variable product**
   - parent catalog/container product
   - two or more SKU variants
   - sellable unit is always the SKU variant
   - variants may differ by options such as size, color, material
   - variants may override image, price, inventory, and shipping characteristics

4. **Fixed bundle product**
   - customer purchases the bundle as one unit
   - bundle is composed of one or more underlying SKU components
   - components may reference:
     - simple product SKUs
     - variable product SKUs
   - bundle price is derived from component prices
   - optional bundle discount is supported:
     - fixed dollar amount
     - percentage
   - bundle has no independent stock
   - bundle stock availability is derived from component stock

5. **Images/media**
   - product-level primary image
   - product-level gallery images
   - variant-level image override
   - image metadata stored via provider-neutral asset records

---

## Non-goals for v1

The following are explicitly out of scope unless separately approved:

- subscriptions
- configurable/customizable bundles chosen by customer
- marketplace / multi-vendor features
- multi-warehouse inventory
- customer-specific pricing
- advanced tax engine integration
- reviews/ratings
- coupons/promotions beyond bundle discount
- product kits with optional substitutions
- internationalized per-locale product copy
- faceted search engine design
- returns/RMA schema
- gift cards
- serial number/license-key issuance

The schema should leave room for future growth, but these features should **not** drive v1 complexity.

---

## Domain model overview

The v1 catalog should be modeled using the following primary entities:

- `products`
- `product_skus`
- `product_attributes`
- `product_attribute_values`
- `product_sku_option_values`
- `product_assets`
- `product_asset_links`
- `digital_assets`
- `digital_entitlements`
- `bundle_components`
- `categories`
- `product_category_links`
- `product_tags`
- `product_tag_links`
- `order_line_snapshots`

Some of these may be implemented as separate tables/collections, or as structured linked collections, depending on EmDash/D1 patterns. The important thing is that the conceptual boundaries remain intact.

---

# 1. Entity specification

## 1.1 `products`

The `products` entity is the main catalog record. It is the storefront-facing/container record.

### Required fields

- `id`
  - stable internal primary identifier
- `type`
  - enum:
    - `simple`
    - `variable`
    - `bundle`
- `status`
  - enum:
    - `draft`
    - `active`
    - `archived`
- `visibility`
  - enum:
    - `public`
    - `hidden`
- `slug`
  - unique storefront handle / URL key
- `title`
- `short_description`
- `long_description`
- `brand`
  - nullable
- `vendor`
  - nullable
- `featured`
  - boolean
- `sort_order`
  - integer
- `created_at`
- `updated_at`
- `published_at`
  - nullable
- `archived_at`
  - nullable

### Recommended fields

- `seo_title`
- `seo_description`
- `badge_text`
  - e.g. `New`, `Limited`, `Best Seller`
- `requires_shipping_default`
  - default for simple products or SKU fallback
- `tax_class_default`
  - default for SKU fallback
- `metadata_json`
  - tightly controlled extensibility field if needed

### Rules

- `slug` must be unique among non-deleted products.
- `variable` products act as catalog parents and must have 2+ SKU rows.
- `simple` products must have exactly 1 SKU row.
- `bundle` products should typically have 1 bundle sellable row if modeled as a purchasable product/SKU pair, but stock is derived from components.

---

## 1.2 `product_skus`

This is the most important commerce entity. Every purchasable unit must have a SKU record.

### Required fields

- `id`
- `product_id`
- `sku`
  - unique merchant SKU code
- `status`
  - enum:
    - `active`
    - `inactive`
    - `archived`
- `title_override`
  - nullable; optional label for variant/sellable display
- `currency`
- `price_minor`
  - integer in minor currency unit
- `compare_at_price_minor`
  - nullable
- `cost_minor`
  - nullable but strongly recommended
- `inventory_mode`
  - enum:
    - `tracked`
    - `not_tracked`
- `inventory_quantity`
  - integer, nullable if `not_tracked`
- `allow_backorder`
  - boolean
- `requires_shipping`
  - boolean
- `is_digital`
  - boolean
- `weight_grams`
  - nullable
- `length_mm`
  - nullable
- `width_mm`
  - nullable
- `height_mm`
  - nullable
- `barcode`
  - nullable
- `tax_class`
  - nullable
- `created_at`
- `updated_at`

### Recommended fields

- `position`
  - sort order inside product
- `fulfillment_type`
  - enum:
    - `physical`
    - `digital`
    - `mixed`
- `hs_code`
  - optional, future trade/shipping support
- `country_of_origin`
  - optional
- `metadata_json`

### Rules

- Every `simple` product must have one SKU.
- Every `variable` product must have at least two SKUs.
- Inventory is always tracked at SKU level.
- Variant-specific price lives on the SKU, not the parent product.
- If `is_digital = true` and `requires_shipping = true`, then this is a mixed-fulfillment SKU and must be supported.
- For `not_tracked` inventory, `inventory_quantity` should be null or ignored.
- Negative inventory should be rejected unless explicitly enabled later.

---

## 1.3 `product_attributes`

Represents the attribute definitions used by variable products or descriptive metadata.

### Required fields

- `id`
- `product_id`
- `name`
  - e.g. `Color`, `Size`
- `code`
  - normalized machine-safe identifier, e.g. `color`, `size`
- `kind`
  - enum:
    - `variant_defining`
    - `descriptive`
- `position`
- `created_at`
- `updated_at`

### Rules

- `variant_defining` attributes determine variant combinations.
- `descriptive` attributes are display-only and should not drive SKU uniqueness.

---

## 1.4 `product_attribute_values`

Allowed values for product attributes.

### Required fields

- `id`
- `attribute_id`
- `value`
  - e.g. `Blue`, `Large`
- `code`
  - normalized, e.g. `blue`, `large`
- `position`

### Rules

- Values must be unique per `attribute_id`.
- Order should be stable for display purposes.

---

## 1.5 `product_sku_option_values`

Maps a SKU to its selected option values for variant-defining attributes.

### Required fields

- `sku_id`
- `attribute_id`
- `attribute_value_id`

### Rules

- Every SKU under a variable product must have exactly one value per variant-defining attribute.
- No duplicate option combinations are allowed within the same product.
- Simple-product single SKUs do not need variant option rows.

---

## 1.6 `product_assets`

Represents a storage-provider-neutral asset record.

This is used for images and may also support downloadable file assets if desired.

### Required fields

- `id`
- `asset_type`
  - enum:
    - `image`
    - `file`
- `storage_provider`
  - enum:
    - `local`
    - `r2`
    - `s3`
    - `other`
- `storage_key`
  - opaque storage path/key
- `original_filename`
- `mime_type`
- `file_size_bytes`
- `checksum`
  - nullable but recommended
- `width_px`
  - nullable
- `height_px`
  - nullable
- `access_mode`
  - enum:
    - `public`
    - `private`
- `created_at`

### Rules

- The schema must not assume local filesystem semantics.
- `storage_key` must be treated as opaque.
- Image dimensions are required when asset_type is `image` if easily available.
- Asset records should be treated as EmDash-aligned media objects, not as overloaded product/content rows.
- The commerce layer should reference assets by ID/linkage, not by assuming direct file ownership inside the product record.

---

## 1.7 `product_asset_links`

Links assets to either products or SKUs.

### Required fields

- `id`
- `product_id`
  - nullable
- `sku_id`
  - nullable
- `asset_id`
- `role`
  - enum:
    - `primary_image`
    - `gallery_image`
    - `variant_image`
- `alt_text`
  - nullable
- `position`
- `created_at`

### Rules

- Exactly one of `product_id` or `sku_id` must be set.
- Product-level galleries belong to product.
- Variant image overrides belong to SKU.
- A product should have at most one `primary_image`.

---

## 1.8 `digital_assets`

Represents downloadable or protected digital content made available to purchasers.

This may share storage with `product_assets`, but logical separation is encouraged.

### Required fields

- `id`
- `asset_id`
  - reference to file asset
- `label`
  - display name for customer/admin
- `download_limit`
  - nullable
- `download_expiry_days`
  - nullable
- `is_manual_only`
  - boolean
- `created_at`
- `updated_at`

### Rules

- These assets are for customer entitlements, not just product media.
- Protected/private access should be the default unless there is a strong reason otherwise.

---

## 1.9 `digital_entitlements`

Maps which digital assets are granted by purchasing a SKU.

### Required fields

- `id`
- `sku_id`
- `digital_asset_id`
- `granted_quantity`
  - usually 1
- `created_at`

### Rules

- This supports:
  - simple digital products
  - mixed physical+digital products
  - bundle-derived digital access via component SKUs or bundle-level explicit entitlements
- Use this instead of forcing physical+digital combinations into a formal bundle model.

---

## 1.10 `bundle_components`

Defines which SKUs make up a fixed bundle.

### Required fields

- `id`
- `bundle_product_id`
- `component_sku_id`
- `quantity`
- `position`
- `created_at`
- `updated_at`

### Bundle pricing fields (on bundle product or separate bundle pricing record)

The bundle must also support:

- `discount_type`
  - enum:
    - `none`
    - `fixed_amount`
    - `percentage`
- `discount_value_minor`
  - nullable for fixed amount
- `discount_value_bps`
  - nullable for percentage, e.g. basis points or percentage integer
- `rounding_mode`
  - enum:
    - `currency_standard`

### Rules

- Bundles are fixed composition only in v1.
- A component must reference a SKU, never a parent product alone.
- Bundle subtotal is derived from component SKUs × quantity.
- Final price = subtotal − bundle discount.
- Bundle inventory is derived from component availability.
- Bundle has no inventory row of its own.
- Bundle should support both:
  - simple-product SKUs
  - variant-product SKUs

### Inventory availability rule

Bundle sellable quantity should be computed as the minimum whole-bundle count supported by component stock:

`min(floor(component_inventory / component_quantity))`

ignoring `not_tracked` SKUs as unlimited for bundle availability purposes.

---

## 1.11 `categories`

### Required fields

- `id`
- `name`
- `slug`
- `parent_id`
  - nullable
- `position`
- `created_at`
- `updated_at`

---

## 1.12 `product_category_links`

### Required fields

- `product_id`
- `category_id`

---

## 1.13 `product_tags`

### Required fields

- `id`
- `name`
- `slug`
- `created_at`

---

## 1.14 `product_tag_links`

### Required fields

- `product_id`
- `tag_id`

---

## 1.15 `order_line_snapshots`

This is a logical entity. It may live inside order line storage or in a dedicated snapshot structure. What matters is the semantics.

### Required snapshot fields per order line

- `product_id`
  - nullable convenience reference
- `sku_id`
  - nullable convenience reference
- `product_type`
- `product_title`
- `product_slug`
  - nullable
- `sku`
- `sku_title`
  - nullable
- `selected_options`
  - structured map/list of attribute name + value
- `currency`
- `unit_price_minor`
- `quantity`
- `line_subtotal_minor`
- `line_discount_minor`
- `line_total_minor`
- `compare_at_price_minor`
  - nullable
- `tax_class`
  - nullable
- `requires_shipping`
- `is_digital`
- `weight_grams`
  - nullable
- `image_snapshot`
  - nullable representative image info
- `bundle_snapshot`
  - nullable, but required for bundle lines:
    - component SKU list
    - quantities
    - derived subtotal at purchase
    - bundle discount type/value
- `digital_entitlement_snapshot`
  - nullable, but recommended when digital access is granted

### Rules

- Snapshot data is the historical truth.
- Live catalog references are optional conveniences only.
- Snapshot must be written at checkout/order creation time.
- Editing the catalog later must not change historical order rendering.

---

# 2. Product type behavior

## 2.1 Simple physical product

### Characteristics

- product type = `simple`
- exactly one SKU
- SKU:
  - `requires_shipping = true`
  - `is_digital = false` unless mixed
- may have:
  - product images
  - digital entitlements attached to the SKU

### Example

A yarn kit sold as one physical shipped item, with an included PDF guide.

---

## 2.2 Simple digital/downloadable product

### Characteristics

- product type = `simple`
- exactly one SKU
- SKU:
  - `requires_shipping = false`
  - `is_digital = true`
- one or more digital entitlements linked to SKU
- no shipping dimensions required

### Example

A downloadable knitting pattern PDF.

---

## 2.3 Variable product

### Characteristics

- product type = `variable`
- 2+ SKU variants
- parent product contains:
  - descriptions
  - merchandising
  - shared image gallery
  - attribute definitions
- SKU variants contain:
  - SKU code
  - option combination
  - price
  - inventory
  - barcode
  - shipping characteristics
  - optional variant image override

### Example

A sweater sold in sizes S/M/L and colors Blue/Red.

---

## 2.4 Bundle product

### Characteristics

- product type = `bundle`
- fixed set of component SKUs
- derived bundle subtotal from components
- optional bundle discount
- no independent stock
- bundle availability derived from component SKU stock
- may include mixed components:
  - physical only
  - digital only
  - physical + digital

### Example

A knitting starter bundle containing:
- one yarn SKU
- one needle SKU
- one pattern PDF SKU

---

# 3. Pricing rules

## 3.1 SKU pricing

Each SKU must support:

- `price_minor`
- `compare_at_price_minor` (optional)
- `currency`

The price on the SKU is the sellable price before cart/order-level promotions.

## 3.2 Bundle pricing

Bundle pricing must be derived from component prices.

### Formula

- Component subtotal = sum(component SKU price × quantity)
- Bundle discount:
  - none
  - fixed amount
  - percentage
- Final bundle price = derived subtotal − discount

### Required decisions

- All bundle component SKUs must share currency.
- Rounding must be deterministic.
- Fixed discount must not reduce final price below zero.
- Percentage discount must be validated within sane bounds.

## 3.3 Sale pricing

v1 may support sale pricing via `compare_at_price_minor`, but a fully scheduled promotions engine is out of scope.

---

# 4. Inventory rules

## 4.1 Inventory belongs to SKU rows

Inventory must never belong to the parent variable product.

## 4.2 Bundle inventory is derived

Bundle availability must be calculated from component SKU stock.

## 4.3 Backorder behavior

A tracked SKU may allow backorders if `allow_backorder = true`.

If a bundle contains any tracked component with insufficient inventory and backorders are not allowed for that component, the bundle should be unavailable beyond supported quantity.

## 4.4 Inventory tracking modes

v1 inventory modes:

- `tracked`
- `not_tracked`

No multi-location or reserved-stock complexity in v1 unless already present elsewhere.

---

# 5. Media and file handling

## 5.1 Product images

The catalog must support:

- one product primary image
- multiple product gallery images
- optional variant image override

## 5.2 Asset abstraction

All media/file records must use provider-neutral storage fields:

- storage provider
- storage key
- MIME type
- size
- checksum
- filename

Do not store hardcoded local absolute paths in the schema.

## 5.3 Digital downloads

Digital files should be modeled as protected assets with entitlement rules. Even if local storage is used initially, schema should remain portable.

---

# 6. Status, visibility, and lifecycle

## 6.1 Product lifecycle states

Required product statuses:

- `draft`
- `active`
- `archived`

Required visibility states:

- `public`
- `hidden`

## 6.2 SKU lifecycle states

Required SKU statuses:

- `active`
- `inactive`
- `archived`

### Rules

- Archived products should remain renderable in historical/admin order contexts.
- Archived SKUs must not break old order displays.
- Do not hard-delete products casually.

---

# 7. Validation rules

The following validations are required.

## 7.1 Product validations

- `simple` product must have exactly one SKU
- `variable` product must have at least two SKUs
- `bundle` product must have at least one bundle component
- `slug` must be unique
- `status` and `visibility` must be valid enums

## 7.2 SKU validations

- `sku` must be unique
- `price_minor` must be non-negative
- `compare_at_price_minor` must be null or >= `price_minor`
- if `inventory_mode = tracked`, inventory quantity must be integer
- if `requires_shipping = false`, dimensions/weight may be null
- if `is_digital = true`, at least one digital entitlement should exist for digital-only products

## 7.3 Variable product validations

- each variant-defining attribute must have allowed values
- each SKU must map one value for each variant-defining attribute
- no duplicate attribute combinations

## 7.4 Bundle validations

- each component must reference a valid SKU
- quantity must be positive integer
- bundle must not reference itself recursively
- all component SKUs must use same currency
- discount must not create negative final price

## 7.5 Asset validations

- primary image uniqueness per product
- only image assets can be linked with image roles
- digital entitlement files should be `private` by default

---

# 8. Retrieval requirements

The developer must support the following retrieval/use cases.

## 8.1 Product detail retrieval

Retrieve one product with:

- core product fields
- active SKU rows
- attributes and values
- primary image + gallery
- variant image overrides
- category/tag associations
- bundle composition if bundle
- digital entitlement summary if needed for admin

## 8.2 Catalog listing retrieval

List products with:

- primary image
- product title
- status/visibility
- price range summary
- inventory summary
- type
- featured flag
- category/tag filters later

## 8.3 Bundle availability retrieval

Given a bundle product, compute:

- component list
- derived subtotal
- discount
- final bundle price
- max available whole-bundle quantity from stock

## 8.4 Variant selection retrieval

Given a variable product, return:

- attributes/options
- allowed combinations
- per-SKU:
  - price
  - inventory
  - image override
  - status

## 8.5 Admin retrieval

Admin views must support:
- draft/inactive products
- archived products
- hidden products
- low stock SKUs
- asset references
- digital entitlement associations

---

# 9. Write/update requirements

## 9.1 Product creation

The developer must support creating:

- simple product + one SKU
- variable product + attribute definitions + multiple SKUs
- bundle product + bundle components + bundle discount config

## 9.2 Product update

Must support updating:

- core product copy and visibility
- SKU price/inventory fields
- product/variant images
- bundle composition
- digital entitlements
- category/tag assignments

## 9.3 Soft lifecycle updates

Must support:
- publish/unpublish
- archive/unarchive
- activate/deactivate SKU

## 9.4 Order snapshot compatibility

When orders are created, the checkout/order flow must be able to consume product/SKU data and write snapshot-compatible line data without requiring schema redesign later.

---

# 10. Recommended implementation order

This section defines the build order. The developer should follow this order unless there is a very strong reason not to.

## Phase 1 — Foundation schema and invariants

Build first:

1. `products`
2. `product_skus`
3. status/visibility enums
4. unique constraints:
   - product slug
   - SKU code
5. base validation layer for product type rules

### Exit criteria

- can create a simple product with one SKU
- can retrieve it
- can update it
- invalid shapes are rejected

---

## Phase 2 — Media/assets abstraction

Build next:

1. `product_assets`
2. `product_asset_links`
3. image roles:
   - primary
   - gallery
   - variant
4. local storage adapter using provider-neutral schema

### Exit criteria

- can upload/link one or more product images
- can assign primary image
- can assign variant image override
- schema does not depend on local-only path assumptions

---

## Phase 3 — Variable product model

Build next:

1. `product_attributes`
2. `product_attribute_values`
3. `product_sku_option_values`
4. validation for duplicate variant combinations

### Exit criteria

- can create variable product
- can define attributes and allowed values
- can create multiple variant SKUs
- can retrieve variant matrix
- duplicate combinations rejected

---

## Phase 4 — Digital entitlement model

Build next:

1. `digital_assets`
2. `digital_entitlements`
3. download metadata and access rules

### Exit criteria

- can create simple digital product
- can attach downloadable assets to SKU
- can attach digital entitlement to physical SKU
- schema remains storage-provider-neutral

---

## Phase 5 — Bundle model

Build next:

1. `bundle_components`
2. bundle pricing fields
3. derived subtotal computation
4. bundle discount computation
5. bundle inventory availability computation

### Exit criteria

- can create fixed bundle from SKU components
- components can be simple or variable SKUs
- final derived price is correct
- bundle quantity availability is computed from component stock
- no independent bundle inventory is stored

---

## Phase 6 — Catalog organization and retrieval

Build next:

1. `categories`
2. `product_category_links`
3. `product_tags`
4. `product_tag_links`
5. catalog-list retrieval shapes
6. admin retrieval shapes

### Exit criteria

- can list products for storefront/admin
- can retrieve products by category/tag
- admin can inspect type/status/basic inventory state

---

## Phase 7 — Order snapshot integration

Build next, before broad launch:

1. order-line snapshot mapping
2. bundle snapshot rules
3. digital entitlement snapshot rules
4. representative image snapshot rules

### Exit criteria

- order creation can store frozen catalog snapshot data
- historical order rendering no longer depends on mutable live catalog rows
- bundles and digital entitlements are represented safely in order history

---

# 11. API/handler recommendations

The exact route names may change, but the following conceptual operations should exist.

## Product operations

- create simple product
- create variable product
- create bundle product
- update product
- archive product
- list products
- get product detail

## SKU operations

- create SKU
- update SKU
- set inventory
- set price
- activate/deactivate SKU

## Asset operations

- upload asset
- link asset to product
- link asset to SKU
- reorder gallery
- set primary image

## Digital operations

- create digital asset
- attach entitlement to SKU
- remove entitlement from SKU

## Bundle operations

- add bundle component
- remove bundle component
- reorder bundle components
- set bundle discount
- compute bundle summary

These may be implemented as explicit handlers or internal service methods depending on EmDash plugin patterns, but the domain boundaries should remain clear.

---

# 12. Order snapshot recommendation explained

The chosen recommendation is:

## **Use order snapshots plus optional live references**

That means:

- keep `product_id` / `sku_id` references if useful
- but always store frozen line-item purchase data at checkout time

### Why this is required

If live product rows change later, the order must still show exactly what the customer bought.

Without snapshots, old orders can become incorrect when:
- titles change
- prices change
- variants are archived
- bundle composition changes
- downloadable assets change

This is not acceptable for real commerce.

---

# 13. Must-pass scenario checklist

The developer should treat the following as must-pass scenarios.

## Simple product scenarios

- create a simple physical product with one SKU
- attach gallery images
- mark draft, publish, archive
- update inventory and price

## Digital product scenarios

- create digital-only simple product
- attach downloadable file
- retrieve entitlement metadata
- confirm no shipping required

## Variable product scenarios

- create parent product with attributes `Color` and `Size`
- create multiple SKU combinations
- assign variant image override
- reject duplicate option combination

## Bundle scenarios

- create fixed bundle from three SKU components
- derive subtotal correctly
- apply fixed discount correctly
- apply percentage discount correctly
- compute bundle availability from component stock
- reject invalid component SKU references

## Mixed physical + digital scenarios

- create physical SKU with attached digital manual/PDF
- ensure shipping still required
- ensure digital entitlement is still granted

## Snapshot scenarios

- place order
- then rename product
- then change price
- then archive SKU
- historical order must still show original purchased data

---

# 14. Developer guidance / anti-patterns

The following are important constraints.

## Do not:

- store inventory on parent variable product rows
- let bundles own independent stock in v1
- force every physical+digital combination into a bundle
- store raw absolute local file paths as canonical schema data
- model files the WordPress way as generic product/content rows
- rely only on live product references for order history
- make product type behavior ambiguous
- support customer-configurable bundles in v1
- over-generalize with speculative plugin extension points before core catalog paths are solid

## Do:

- keep schema explicit
- keep sellable-unit logic on SKU rows
- keep bundle composition at SKU level
- keep storage provider abstracted
- build retrieval shapes that match real storefront/admin needs
- protect invariants with validation at write time

---

# 15. Final recommended v1 minimum deliverable

The minimum acceptable deliverable for this product catalog project is:

1. simple physical product with one SKU
2. simple digital product with one SKU and downloadable entitlement
3. variable product with attributes and SKU variants
4. fixed bundle product composed of SKU-level components
5. product gallery plus variant image override
6. product status and visibility controls
7. SKU-level inventory and price fields
8. digital entitlement support for mixed physical+digital sales
9. category/tag assignment
10. order-line snapshot compatibility

If these ten areas are implemented cleanly, the catalog foundation will be strong enough to support real commerce evolution without immediate redesign.

---

## Final instruction to developer

Build this in phases, keep the catalog kernel narrow, and protect invariants early. Do not skip the sellable-unit model, bundle rules, or order snapshot compatibility. Those are the structural decisions most likely to prevent painful rework later.
