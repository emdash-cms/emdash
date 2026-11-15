import { describe, expect, it } from "vitest";

import { shopOrderCreateBody } from "../../../src/api/schemas/shop.js";

const baseOrder = {
	items: [{ productId: "product-1", quantity: 1 }],
	customer: {
		firstName: "Ana",
		lastName: "Torres",
		phone: "999888777",
	},
	paymentMethod: "whatsapp",
};

describe("shopOrderCreateBody", () => {
	it("requires first and last name for new checkouts", () => {
		expect(shopOrderCreateBody.safeParse(baseOrder).success).toBe(true);
		expect(
			shopOrderCreateBody.safeParse({
				...baseOrder,
				customer: { ...baseOrder.customer, firstName: "   " },
			}).success,
		).toBe(false);
		expect(
			shopOrderCreateBody.safeParse({
				...baseOrder,
				customer: { ...baseOrder.customer, lastName: "" },
			}).success,
		).toBe(false);
	});

	it("trims first and last name while preserving the optional compatibility alias", () => {
		const result = shopOrderCreateBody.parse({
			...baseOrder,
			customer: {
				...baseOrder.customer,
				firstName: " Ana ",
				lastName: " Torres ",
				name: " Ana Torres ",
			},
		});

		expect(result.customer.firstName).toBe("Ana");
		expect(result.customer.lastName).toBe("Torres");
		expect(result.customer.name).toBe("Ana Torres");
	});

	it("accepts an empty item list when checkout resolves a persisted cart", () => {
		const result = shopOrderCreateBody.safeParse({
			...baseOrder,
			items: [],
			cartToken: "A".repeat(43),
		});
		expect(result.success).toBe(true);
		expect(
			shopOrderCreateBody.safeParse({ ...baseOrder, items: [], cartToken: "invalid" }).success,
		).toBe(false);
	});
});
