import { ClockCounterClockwise } from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";

import { buildNavItems } from "../../src/components/AdminCommandPalette";

describe("buildNavItems", () => {
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
		);

		expect(items.find((item) => item.id === "plugin-audit-log-/history")?.icon).toBe(
			ClockCounterClockwise,
		);
	});
});
