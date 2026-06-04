import { describe, it, expect } from "vitest";

import { MEDIA_SEARCH_MAX_LENGTH, normalizeMediaSearch } from "../../src/lib/api/media";

describe("normalizeMediaSearch", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeMediaSearch("  hero.png  ")).toBe("hero.png");
	});

	it("returns an empty string for nullish or whitespace-only input", () => {
		expect(normalizeMediaSearch(undefined)).toBe("");
		expect(normalizeMediaSearch(null)).toBe("");
		expect(normalizeMediaSearch("   ")).toBe("");
	});

	it("clamps to the server-accepted maximum length to avoid 400s", () => {
		const long = "a".repeat(MEDIA_SEARCH_MAX_LENGTH + 50);
		const result = normalizeMediaSearch(long);
		expect(result).toHaveLength(MEDIA_SEARCH_MAX_LENGTH);
	});

	it("leaves a normal term untouched", () => {
		expect(normalizeMediaSearch("logo")).toBe("logo");
	});
});
