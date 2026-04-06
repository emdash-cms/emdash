import { describe, expect, it } from "vitest";

import { COMMERCE_STORAGE_CONFIG } from "../storage.js";

type IndexKind = string | readonly string[];

function includesIndex(
	collection:
		| "orders"
		| "carts"
		| "paymentAttempts"
		| "productAssets"
		| "productAssetLinks"
		| "webhookReceipts"
		| "idempotencyKeys"
		| "products"
		| "productSkus"
		| "productAttributes"
		| "productAttributeValues"
		| "productSkuOptionValues"
		| "digitalAssets"
		| "digitalEntitlements"
		| "categories"
		| "productCategoryLinks"
		| "productTags"
		| "productTagLinks"
		| "bundleComponents"
		| "inventoryLedger"
		| "inventoryStock",
	index: readonly string[],
	unique = false,
): boolean {
	const cfg = COMMERCE_STORAGE_CONFIG[collection];
	const bucket = unique
		? "uniqueIndexes" in cfg
			? ((cfg as { uniqueIndexes?: readonly IndexKind[] }).uniqueIndexes ?? [])
			: []
		: cfg.indexes;
	return bucket.some((entry: IndexKind) => {
		if (typeof entry === "string") {
			return index.length === 1 && entry === index[0];
		}
		return entry.length === index.length && entry.every((part, i) => part === index[i]);
	});
}

describe("storage index contracts", () => {
	it("supports payment attempt lookup path used by finalize/idempotency", () => {
		expect(includesIndex("paymentAttempts", ["orderId", "providerId", "status"])).toBe(true);
	});

	it("supports inventory reconciliation lookup path for finalize", () => {
		expect(includesIndex("inventoryLedger", ["referenceType", "referenceId"])).toBe(true);
	});

	it("contains required unique constraints for duplicate-safe writes", () => {
		expect(includesIndex("webhookReceipts", ["providerId", "externalEventId"], true)).toBe(true);
		expect(includesIndex("idempotencyKeys", ["keyHash", "route"], true)).toBe(true);
		expect(
			includesIndex(
				"inventoryLedger",
				["referenceType", "referenceId", "productId", "variantId"],
				true,
			),
		).toBe(true);
	});

	it("keeps deterministic index coverage for status-read diagnostics path", () => {
		expect(includesIndex("inventoryStock", ["productId", "variantId"], true)).toBe(true);
		expect(includesIndex("paymentAttempts", ["orderId", "providerId", "status"])).toBe(true);
	});

	it("supports catalog product lookup and uniqueness invariants", () => {
		expect(includesIndex("products", ["slug"])).toBe(true);
		expect(includesIndex("products", ["slug"], true)).toBe(true);
		expect(includesIndex("products", ["status"])).toBe(true);
	});

	it("supports catalog SKU lookup and sku-code uniqueness invariants", () => {
		expect(includesIndex("productSkus", ["productId"])).toBe(true);
		expect(includesIndex("productSkus", ["skuCode"], true)).toBe(true);
	});

	it("supports catalog asset records and lookup invariants", () => {
		expect(includesIndex("productAssets", ["provider", "externalAssetId"])).toBe(true);
		expect(includesIndex("productAssets", ["provider", "externalAssetId"], true)).toBe(true);
	});

	it("supports catalog asset link lookup and idempotent linking", () => {
		expect(includesIndex("productAssetLinks", ["targetType", "targetId"])).toBe(true);
		expect(includesIndex("productAssetLinks", ["targetType", "targetId", "assetId"], true)).toBe(
			true,
		);
	});

	it("supports variable attribute metadata lookups", () => {
		expect(includesIndex("productAttributes", ["productId"])).toBe(true);
		expect(includesIndex("productAttributes", ["productId", "kind"])).toBe(true);
		expect(includesIndex("productAttributes", ["productId", "code"], true)).toBe(true);
		expect(includesIndex("productAttributeValues", ["attributeId"])).toBe(true);
		expect(includesIndex("productAttributeValues", ["attributeId", "code"], true)).toBe(true);
	});

	it("supports SKU option mapping invariants", () => {
		expect(includesIndex("productSkuOptionValues", ["skuId"])).toBe(true);
		expect(includesIndex("productSkuOptionValues", ["attributeId"])).toBe(true);
		expect(includesIndex("productSkuOptionValues", ["skuId", "attributeId"], true)).toBe(true);
	});

	it("supports digital asset records and entitlements", () => {
		expect(includesIndex("digitalAssets", ["provider", "externalAssetId"])).toBe(true);
		expect(includesIndex("digitalAssets", ["provider", "externalAssetId"], true)).toBe(true);
		expect(includesIndex("digitalEntitlements", ["skuId"])).toBe(true);
		expect(includesIndex("digitalEntitlements", ["digitalAssetId"])).toBe(true);
		expect(includesIndex("digitalEntitlements", ["skuId", "digitalAssetId"], true)).toBe(true);
	});

	it("supports bundle components and composition lookups", () => {
		expect(includesIndex("bundleComponents", ["bundleProductId"])).toBe(true);
		expect(includesIndex("bundleComponents", ["bundleProductId", "componentSkuId"], true)).toBe(
			true,
		);
		expect(includesIndex("bundleComponents", ["bundleProductId", "position"])).toBe(true);
	});

	it("supports catalog organization lookup indexes", () => {
		expect(includesIndex("categories", ["slug"])).toBe(true);
		expect(includesIndex("categories", ["slug"], true)).toBe(true);
		expect(includesIndex("categories", ["parentId"])).toBe(true);
		expect(includesIndex("productCategoryLinks", ["productId"])).toBe(true);
		expect(includesIndex("productCategoryLinks", ["categoryId"])).toBe(true);
		expect(includesIndex("productCategoryLinks", ["productId", "categoryId"], true)).toBe(true);
		expect(includesIndex("productTags", ["slug"])).toBe(true);
		expect(includesIndex("productTags", ["slug"], true)).toBe(true);
		expect(includesIndex("productTagLinks", ["productId"])).toBe(true);
		expect(includesIndex("productTagLinks", ["tagId"])).toBe(true);
		expect(includesIndex("productTagLinks", ["productId", "tagId"], true)).toBe(true);
	});
});
