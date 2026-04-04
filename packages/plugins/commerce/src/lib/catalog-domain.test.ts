import { describe, expect, it } from "vitest";

import type { StoredProduct, StoredProductSku } from "../types.js";
import { applyProductSkuUpdatePatch, applyProductUpdatePatch } from "./catalog-domain.js";

const isoNow = "2026-01-01T00:00:00.000Z";

function asProductPatch(value: Parameters<typeof applyProductUpdatePatch>[1]): Parameters<typeof applyProductUpdatePatch>[1] {
	return value as Parameters<typeof applyProductUpdatePatch>[1];
}

function asSkuPatch(value: Parameters<typeof applyProductSkuUpdatePatch>[1]): Parameters<typeof applyProductSkuUpdatePatch>[1] {
	return value as Parameters<typeof applyProductSkuUpdatePatch>[1];
}

describe("catalog-domain helpers", () => {
	it("prevents immutable product fields from being updated", () => {
		const product: StoredProduct = {
			id: "prod_1",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "existing",
			title: "Original",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2025-12-01T00:00:00.000Z",
			updatedAt: "2025-12-01T00:00:00.000Z",
		};

		expect(() => applyProductUpdatePatch(product, asProductPatch({ type: "bundle" }), isoNow)).toThrow();
	});

	it("prevents slug rewrites on active products", () => {
		const product: StoredProduct = {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "existing",
			title: "Original",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2025-12-01T00:00:00.000Z",
			updatedAt: "2025-12-01T00:00:00.000Z",
		};

		expect(() => applyProductUpdatePatch(product, asProductPatch({ slug: "new-slug" }), isoNow)).toThrow();
	});

	it("applies safe mutable product and sku updates", () => {
		const product: StoredProduct = {
			id: "prod_1",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "existing",
			title: "Original",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2025-12-01T00:00:00.000Z",
			updatedAt: "2025-12-01T00:00:00.000Z",
		};

		const productResult = applyProductUpdatePatch(product, asProductPatch({ title: "Updated" }), isoNow);
		expect(productResult.title).toBe("Updated");
		expect(productResult.updatedAt).toBe(isoNow);
		expect(productResult.id).toBe("prod_1");

		const sku: StoredProductSku = {
			id: "sku_1",
			productId: "prod_1",
			skuCode: "SKU-1",
			status: "active",
			unitPriceMinor: 1000,
			inventoryQuantity: 5,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: "2025-12-01T00:00:00.000Z",
			updatedAt: "2025-12-01T00:00:00.000Z",
		};

		const skuResult = applyProductSkuUpdatePatch(sku, asSkuPatch({ unitPriceMinor: 1200 }), isoNow);
		expect(skuResult.unitPriceMinor).toBe(1200);
		expect(skuResult.productId).toBe("prod_1");
	});
});
