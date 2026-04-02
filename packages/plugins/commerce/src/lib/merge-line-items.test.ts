import { describe, expect, it } from "vitest";

import { mergeLineItemsBySku } from "./merge-line-items.js";

describe("mergeLineItemsBySku", () => {
	it("sums quantities for identical SKU snapshots", () => {
		const out = mergeLineItemsBySku([
			{
				productId: "a",
				variantId: "",
				quantity: 1,
				inventoryVersion: 2,
				unitPriceMinor: 100,
			},
			{
				productId: "a",
				variantId: "",
				quantity: 3,
				inventoryVersion: 2,
				unitPriceMinor: 100,
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]!.quantity).toBe(4);
	});

	it("throws when duplicate SKU has mismatched version", () => {
		expect(() =>
			mergeLineItemsBySku([
				{
					productId: "a",
					quantity: 1,
					inventoryVersion: 1,
					unitPriceMinor: 100,
				},
				{
					productId: "a",
					quantity: 1,
					inventoryVersion: 2,
					unitPriceMinor: 100,
				},
			]),
		).toThrow(/inventoryVersion/);
	});
});
