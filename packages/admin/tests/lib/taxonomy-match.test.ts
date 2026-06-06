import { describe, it, expect } from "vitest";

import {
	foldForMatch,
	termExactMatches,
	termMatches,
	type MatchableTerm,
} from "../../src/lib/taxonomy-match.js";

/**
 * Tests for the admin picker matcher. The matcher is the sole gate between
 * an editor's typed input and the "Create new term" escape hatch, so every
 * branch has real user impact:
 *
 *   - accent-fold branch: `"Mexico"` must find `"México"` or editors create
 *     a duplicate term and fragment the taxonomy.
 *   - no-match branch: genuinely new terms must still offer Create.
 *   - exact-match branch: governs whether Create is suppressed, so an
 *     accent-insensitive exact match must count.
 */

const mexico: MatchableTerm = { label: "México" };
const hongKong: MatchableTerm = { label: "Hong Kong" };

describe("foldForMatch", () => {
	it("folds diacritics and case to the same key", () => {
		expect(foldForMatch("México")).toBe("mexico");
		expect(foldForMatch("MEXICO")).toBe("mexico");
		expect(foldForMatch("méxico")).toBe("mexico");
	});

	it("handles empty input", () => {
		expect(foldForMatch("")).toBe("");
	});

	it("leaves non-accented characters unchanged", () => {
		expect(foldForMatch("USA")).toBe("usa");
		expect(foldForMatch("Hong Kong")).toBe("hong kong");
	});

	it("handles precomposed and decomposed forms identically", () => {
		// Precomposed U+00E9 vs decomposed U+0065 U+0301 both fold to "e".
		expect(foldForMatch("caf\u00e9")).toBe("cafe");
		expect(foldForMatch("cafe\u0301")).toBe("cafe");
	});
});

describe("termMatches", () => {
	it("matches across the diacritic boundary (regression: Mexico/México)", () => {
		expect(termMatches(mexico, "Mexico")).toBe(true);
		expect(termMatches(mexico, "mexico")).toBe(true);
		expect(termMatches(mexico, "MEX")).toBe(true);
	});

	it("matches an accented term against an accented query too", () => {
		expect(termMatches(mexico, "México")).toBe(true);
		expect(termMatches(mexico, "méx")).toBe(true);
	});

	it("does not match genuinely unrelated input (Create button must still appear)", () => {
		expect(termMatches(mexico, "Japan")).toBe(false);
		expect(termMatches(hongKong, "Canada")).toBe(false);
	});

	it("returns false for empty input so the dropdown stays closed", () => {
		expect(termMatches(mexico, "")).toBe(false);
	});

	it("rejects whitespace-only input even when term labels contain spaces", () => {
		// Regression guard: the label `"Hong Kong"` contains a space,
		// so a naive `includes(needle)` without a whitespace guard would
		// match a needle of `"   "` and surface every multi-word term.
		expect(termMatches(hongKong, "   ")).toBe(false);
		expect(termMatches(hongKong, " ")).toBe(false);
	});

	it("tolerates terms carrying unknown keys without crashing", () => {
		const term = { label: "Canadá", extra: 42 } as unknown as MatchableTerm;
		expect(termMatches(term, "Canada")).toBe(true);
	});
});

describe("termExactMatches", () => {
	it("treats diacritic-only differences as equal (so Create stays hidden)", () => {
		expect(termExactMatches(mexico, "Mexico")).toBe(true);
		expect(termExactMatches(mexico, "México")).toBe(true);
	});

	it("is stricter than termMatches — substrings do not count as exact", () => {
		expect(termExactMatches(mexico, "Mex")).toBe(false);
		expect(termExactMatches(hongKong, "Hong")).toBe(false);
	});

	it("returns false for empty or whitespace-only input", () => {
		expect(termExactMatches(mexico, "")).toBe(false);
		expect(termExactMatches(mexico, "   ")).toBe(false);
	});
});
