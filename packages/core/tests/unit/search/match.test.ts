import { describe, expect, it } from "vitest";

import { buildFtsPrefixMatch, buildSlugGlobPrefix } from "../../../src/search/match.js";

describe("buildFtsPrefixMatch", () => {
	it("quotes each term with prefix matching, implicit AND", () => {
		expect(buildFtsPrefixMatch("hello wor")).toBe('"hello"* "wor"*');
	});

	it("escapes interior double quotes so no input can produce FTS5 syntax errors", () => {
		expect(buildFtsPrefixMatch('say "hi"')).toBe('"say"* """hi"""*');
	});

	it("neutralizes FTS5 operators by quoting them", () => {
		expect(buildFtsPrefixMatch("cats AND dogs")).toBe('"cats"* "AND"* "dogs"*');
	});

	it("returns empty string for whitespace-only input", () => {
		expect(buildFtsPrefixMatch("   ")).toBe("");
	});
});

describe("buildSlugGlobPrefix", () => {
	it("lowercases and appends the prefix wildcard", () => {
		expect(buildSlugGlobPrefix("My-Post")).toBe("my-post*");
	});

	it("treats GLOB metacharacters literally via character classes", () => {
		expect(buildSlugGlobPrefix("a*b?c[d]")).toBe("a[*]b[?]c[[]d[]]*");
	});
});
