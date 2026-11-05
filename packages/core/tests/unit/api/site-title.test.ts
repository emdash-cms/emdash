import { describe, expect, it } from "vitest";

import { resolveSiteTitle } from "../../../src/api/site-title.js";

describe("resolveSiteTitle", () => {
	it("prefers the Settings title", () => {
		expect(resolveSiteTitle("Settings Site", "Setup Site")).toBe("Settings Site");
	});

	it("falls back to the setup title when Settings is empty", () => {
		expect(resolveSiteTitle("", "Setup Site")).toBe("Setup Site");
	});

	it("falls back to the setup title when Settings contains an invalid value", () => {
		expect(resolveSiteTitle(42, "Setup Site")).toBe("Setup Site");
	});

	it("ignores invalid stored setup titles", () => {
		expect(resolveSiteTitle("Settings Site", null)).toBe("Settings Site");
		expect(resolveSiteTitle(null, { title: "Setup Site" })).toBeUndefined();
	});

	it("returns undefined when both titles are empty", () => {
		expect(resolveSiteTitle("", "")).toBeUndefined();
	});
});
