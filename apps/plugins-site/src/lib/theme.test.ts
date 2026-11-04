import { describe, expect, it } from "vitest";

import { parseThemePreference, resolveTheme, storedThemeValue } from "./theme.js";

describe("parseThemePreference", () => {
	it("keeps explicit light and dark choices", () => {
		expect(parseThemePreference("light")).toBe("light");
		expect(parseThemePreference("dark")).toBe("dark");
	});

	it("falls back to system for anything else", () => {
		expect(parseThemePreference(null)).toBe("system");
		expect(parseThemePreference(undefined)).toBe("system");
		expect(parseThemePreference("")).toBe("system");
		expect(parseThemePreference("system")).toBe("system");
		expect(parseThemePreference("Dark")).toBe("system");
		expect(parseThemePreference("sepia")).toBe("system");
	});
});

describe("resolveTheme", () => {
	it("follows the operating system when the preference is system", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});

	it("ignores the operating system for an explicit choice", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});
});

describe("storedThemeValue", () => {
	it("clears storage for system so later OS changes apply", () => {
		expect(storedThemeValue("system")).toBeNull();
	});

	it("round-trips explicit choices through parseThemePreference", () => {
		for (const preference of ["light", "dark"] as const) {
			expect(parseThemePreference(storedThemeValue(preference))).toBe(preference);
		}
	});
});
