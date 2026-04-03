import { describe, expect, it } from "vitest";

import { projectCartLineItemsForFingerprint, projectCartLineItemsForStorage } from "./cart-lines.js";

describe("cart line item projections", () => {
	it("projects only stable cart line fields for storage", () => {
		const input = [
			{
				productId: "sku-1",
				quantity: 2,
				inventoryVersion: 9,
				unitPriceMinor: 1234,
				variantId: "variant-1",
				extraField: "should disappear",
			} as const,
		];

		const projected = projectCartLineItemsForStorage(input);

		expect(projected).toEqual([
			{
				productId: "sku-1",
				variantId: "variant-1",
				quantity: 2,
				inventoryVersion: 9,
				unitPriceMinor: 1234,
			},
		]);
	});

	it("normalizes for fingerprinting with deterministic sorting", () => {
		const input = [
			{ productId: "beta", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 },
			{ productId: "alpha", quantity: 1, variantId: "z", inventoryVersion: 1, unitPriceMinor: 100 },
			{ productId: "alpha", quantity: 2, inventoryVersion: 1, unitPriceMinor: 200 },
			{ productId: "alpha", quantity: 1, variantId: "a", inventoryVersion: 1, unitPriceMinor: 150 },
		];

		const projected = projectCartLineItemsForFingerprint(input);

		expect(projected).toHaveLength(4);
		expect(projected[0]?.productId).toBe("alpha");
		expect(projected[0]?.variantId).toBe("");
		expect(projected[1]?.variantId).toBe("a");
		expect(projected[2]?.variantId).toBe("z");
		expect(projected[3]?.productId).toBe("beta");
	});
});
