import { describe, expect, it } from "vitest";

import { cartContentFingerprint } from "./cart-fingerprint.js";

describe("cartContentFingerprint", () => {
	it("changes when line data changes", () => {
		const a = cartContentFingerprint([
			{
				productId: "p",
				quantity: 1,
				inventoryVersion: 1,
				unitPriceMinor: 50,
			},
		]);
		const b = cartContentFingerprint([
			{
				productId: "p",
				quantity: 2,
				inventoryVersion: 1,
				unitPriceMinor: 50,
			},
		]);
		expect(a).not.toBe(b);
	});

	it("is stable under line reorder", () => {
		const line1 = {
			productId: "a",
			quantity: 1,
			inventoryVersion: 1,
			unitPriceMinor: 1,
		};
		const line2 = {
			productId: "b",
			quantity: 1,
			inventoryVersion: 1,
			unitPriceMinor: 2,
		};
		expect(cartContentFingerprint([line1, line2])).toBe(cartContentFingerprint([line2, line1]));
	});
});
