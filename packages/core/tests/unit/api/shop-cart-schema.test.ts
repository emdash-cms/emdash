import { describe, expect, it } from "vitest";

import { shopCartItemCreateBody, shopCartItemUpdateBody } from "../../../src/api/schemas/shop-cart.js";

describe("shop cart schemas", () => {
	it("accepts a product line and rejects invalid quantities", () => {
		expect(shopCartItemCreateBody.safeParse({ productId: "p-1", quantity: 2 }).success).toBe(true);
		expect(shopCartItemCreateBody.safeParse({ productId: "p-1", quantity: 0 }).success).toBe(false);
		expect(shopCartItemUpdateBody.safeParse({ quantity: 101 }).success).toBe(false);
	});
});
