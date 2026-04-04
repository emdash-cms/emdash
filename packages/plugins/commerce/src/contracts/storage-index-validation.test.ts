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
		expect(includesIndex("productAssetLinks", ["targetType", "targetId", "assetId"], true)).toBe(true);
	});
});
