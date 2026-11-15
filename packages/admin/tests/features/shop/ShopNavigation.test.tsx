import { describe, expect, it } from "vitest";

import { ShopNavigation } from "../../../src/features/shop/navigation/ShopNavigation.js";
import { render } from "../../utils/render.tsx";

describe("ShopNavigation", () => {
	it("exposes route-backed links for every ecommerce area", async () => {
		const screen = await render(<ShopNavigation activeSection="orders" />);

		await expect
			.element(screen.getByRole("link", { name: /Store settings/ }))
			.toHaveAttribute("href", "/shop/settings");
		await expect
			.element(screen.getByRole("link", { name: /Orders/ }))
			.toHaveAttribute("href", "/shop/orders");
		await expect
			.element(screen.getByRole("link", { name: /Bookings/ }))
			.toHaveAttribute("href", "/shop/bookings");
	});

	it("marks the current ecommerce area for assistive technology", async () => {
		const screen = await render(<ShopNavigation activeSection="coupons" />);

		await expect
			.element(screen.getByRole("link", { name: /Coupons/ }))
			.toHaveAttribute("aria-current", "page");
		await expect
			.element(screen.getByRole("link", { name: /Orders/ }))
			.not.toHaveAttribute("aria-current", "page");
	});
});
