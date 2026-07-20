import { Browser, ClockCounterClockwise, Download, Files, Newspaper } from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";

import { buildNavItems } from "../../src/components/AdminCommandPalette";

describe("buildNavItems", () => {
	it("uses collection overrides and the default collection icon", () => {
		const items = buildNavItems(
			{
				collections: {
					pages: { label: "Pages" },
					posts: { label: "Posts" },
					products: { label: "Products" },
				},
				plugins: {},
			},
			50,
			(id) => id,
		);

		expect(items.find((item) => item.id === "collection-pages")?.icon).toBe(Browser);
		expect(items.find((item) => item.id === "collection-posts")?.icon).toBe(Newspaper);
		expect(items.find((item) => item.id === "collection-products")?.icon).toBe(Files);
		expect(items.find((item) => item.id === "import")?.icon).toBe(Download);
	});

	it("uses a plugin page's declared icon", () => {
		const items = buildNavItems(
			{
				collections: {},
				plugins: {
					"audit-log": {
						enabled: true,
						adminPages: [{ path: "/history", label: "Audit History", icon: "history" }],
					},
				},
			},
			50,
			(id) => id,
		);

		expect(items.find((item) => item.id === "plugin-audit-log-/history")?.icon).toBe(
			ClockCounterClockwise,
		);
	});
});
