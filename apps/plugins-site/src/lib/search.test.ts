import { describe, expect, it } from "vitest";

import type { PackageSummary } from "./home.js";
import { refineKeywords, resultSummary } from "./search.js";

const plugin = (keywords: string[]): PackageSummary => ({
	did: "did:plc:test",
	profile: { keywords },
});

describe("resultSummary", () => {
	it("counts the whole registry without a query", () => {
		expect(resultSummary("", 87)).toBe("87 in the registry");
	});

	it("marks a capped list as open-ended", () => {
		expect(resultSummary("", 100)).toBe("100+ in the registry");
		expect(resultSummary("seo", 100)).toBe("100+ plugins");
	});

	it("names search results in the singular and plural", () => {
		expect(resultSummary("seo", 0)).toBe("No matches");
		expect(resultSummary("seo", 1)).toBe("1 plugin");
		expect(resultSummary("seo", 12)).toBe("12 plugins");
	});
});

describe("refineKeywords", () => {
	const packages = [
		plugin(["SEO", "analytics", "a", "b", "c", "d", "e"]),
		plugin(["seo", "analytics", "a", "b", "c", "d", "e"]),
	];

	it("leaves out the current query, ignoring case and spaces", () => {
		expect(refineKeywords(packages, " Seo ")).not.toContain("seo");
	});

	it("offers at most six keywords", () => {
		expect(refineKeywords(packages, "")).toHaveLength(6);
		expect(refineKeywords(packages, "seo")).toHaveLength(6);
	});
});
