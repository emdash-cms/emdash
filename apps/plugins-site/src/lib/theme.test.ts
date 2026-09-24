import { describe, expect, it } from "vitest";

import { toggledThemePreference } from "./theme.js";

describe("theme preference toggle", () => {
	it("creates an override when switching away from the system theme", () => {
		expect(toggledThemePreference("light", "light")).toBe("dark");
		expect(toggledThemePreference("dark", "dark")).toBe("light");
	});

	it("returns to system when the requested theme matches it", () => {
		expect(toggledThemePreference("dark", "light")).toBe("system");
		expect(toggledThemePreference("light", "dark")).toBe("system");
	});
});
