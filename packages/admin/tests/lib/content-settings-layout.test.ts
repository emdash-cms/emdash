import { describe, expect, it } from "vitest";

import {
	DEFAULT_CONTENT_SETTINGS_SECTION_ORDER,
	parseContentSettingsLayout,
	reorderContentSettingsLayout,
	resolveContentSettingsLayout,
} from "../../src/lib/content-settings-layout";

describe("content settings layout", () => {
	it("ignores malformed browser state", () => {
		expect(parseContentSettingsLayout(null)).toBeNull();
		expect(parseContentSettingsLayout("not-json")).toBeNull();
		expect(parseContentSettingsLayout('{"version":2,"order":[]}')).toBeNull();
	});

	it("removes unknown and duplicate ids, then appends missing defaults", () => {
		const stored = parseContentSettingsLayout(
			JSON.stringify({
				version: 1,
				order: ["seo", "unknown", "ownership", "seo"],
			}),
		);

		expect(resolveContentSettingsLayout(stored).order).toEqual([
			"seo",
			"ownership",
			...DEFAULT_CONTENT_SETTINGS_SECTION_ORDER.filter((id) => id !== "seo" && id !== "ownership"),
		]);
	});

	it("moves a section relative to another section", () => {
		const layout = resolveContentSettingsLayout(null);
		const next = reorderContentSettingsLayout(layout, "seo", "ownership");

		expect(next.order.indexOf("seo")).toBe(next.order.indexOf("ownership") - 1);
		expect(layout.order).toEqual(DEFAULT_CONTENT_SETTINGS_SECTION_ORDER);
	});
});
