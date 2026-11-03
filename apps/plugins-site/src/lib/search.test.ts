import { describe, expect, it } from "vitest";

import type { PackageSummary } from "./home.js";
import { pageLinks, parsePage, refineKeywords, resultSummary, searchHref } from "./search.js";

const plugin = (keywords: string[]): PackageSummary => ({
	did: "did:plc:test",
	profile: { keywords },
});

describe("resultSummary", () => {
	it("counts the whole registry without a query", () => {
		expect(resultSummary("", 131)).toBe("131 in the registry");
	});

	it("names search results in the singular and plural", () => {
		expect(resultSummary("seo", 0)).toBe("No matches");
		expect(resultSummary("seo", 1)).toBe("1 plugin");
		expect(resultSummary("seo", 112)).toBe("112 plugins");
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

describe("parsePage", () => {
	it("starts on the first page", () => {
		expect(parsePage(null)).toBe(1);
	});

	it("accepts only whole page numbers from 1", () => {
		expect(parsePage("1")).toBe(1);
		expect(parsePage("12")).toBe(12);
		for (const value of ["", "0", "-1", "1.5", "02", "2abc", " 2"]) {
			expect(parsePage(value)).toBeUndefined();
		}
	});
});

describe("searchHref", () => {
	it("leaves the first page and an empty query out of the URL", () => {
		expect(searchHref("")).toBe("/search");
		expect(searchHref("", 1)).toBe("/search");
		expect(searchHref("", 3)).toBe("/search?page=3");
		expect(searchHref("seo")).toBe("/search?q=seo");
	});

	it("keeps the query when changing pages", () => {
		expect(searchHref("contact & forms", 2)).toBe("/search?q=contact%20%26%20forms&page=2");
	});
});

describe("pageLinks", () => {
	it("links every page when there are seven or fewer", () => {
		expect(pageLinks(1, 1)).toEqual([1]);
		expect(pageLinks(2, 3)).toEqual([1, 2, 3]);
		expect(pageLinks(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("keeps the ends and the current page's neighbours, with gaps between", () => {
		expect(pageLinks(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
		expect(pageLinks(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
		expect(pageLinks(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
	});

	it("shows a page in place of a gap that would hide only that page", () => {
		expect(pageLinks(4, 8)).toEqual([1, 2, 3, 4, 5, "gap", 8]);
		expect(pageLinks(5, 8)).toEqual([1, "gap", 4, 5, 6, 7, 8]);
	});

	it("always returns seven items past seven pages, so the links stay in place", () => {
		for (let count = 8; count <= 30; count++) {
			for (let current = 1; current <= count; current++) {
				const links = pageLinks(current, count);
				expect(links).toHaveLength(7);
				expect(links).toContain(current);
				expect(links.at(0)).toBe(1);
				expect(links.at(-1)).toBe(count);
			}
		}
	});
});
