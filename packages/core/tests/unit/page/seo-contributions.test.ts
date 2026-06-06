/**
 * generateSiteSeoContributions() Tests
 *
 * Bug context: SiteSettings.seo.googleVerification and bingVerification are
 * stored in the database and editable in the admin UI, but were never emitted
 * as <meta> tags into <head>. This left Google Search Console and Bing
 * Webmaster Tools verification impossible via meta-tag method.
 *
 * Fix: A new pure function generates the verification meta contributions from
 * site SEO settings, and EmDashHead.astro loads settings and includes them.
 */

import { describe, it, expect } from "vitest";

import { generateSiteSeoContributions } from "../../../src/page/seo-contributions.js";

describe("generateSiteSeoContributions", () => {
	it("returns empty array when no settings provided", () => {
		const result = generateSiteSeoContributions(undefined);
		expect(result).toEqual([]);
	});

	it("returns empty array when seo settings are empty", () => {
		const result = generateSiteSeoContributions({});
		expect(result).toEqual([]);
	});

	it("emits google-site-verification meta when googleVerification is set", () => {
		const result = generateSiteSeoContributions({
			googleVerification: "abc123",
		});

		expect(result).toContainEqual({
			kind: "meta",
			name: "google-site-verification",
			content: "abc123",
		});
	});

	it("emits msvalidate.01 meta when bingVerification is set", () => {
		const result = generateSiteSeoContributions({
			bingVerification: "xyz789",
		});

		expect(result).toContainEqual({
			kind: "meta",
			name: "msvalidate.01",
			content: "xyz789",
		});
	});

	it("emits both verification tags when both are set", () => {
		const result = generateSiteSeoContributions({
			googleVerification: "g-token",
			bingVerification: "b-token",
		});

		expect(result).toHaveLength(2);
		expect(result).toContainEqual({
			kind: "meta",
			name: "google-site-verification",
			content: "g-token",
		});
		expect(result).toContainEqual({
			kind: "meta",
			name: "msvalidate.01",
			content: "b-token",
		});
	});

	it("ignores empty string values", () => {
		const result = generateSiteSeoContributions({
			googleVerification: "",
			bingVerification: "",
		});

		expect(result).toEqual([]);
	});

	it("ignores unrelated seo settings without crashing", () => {
		const result = generateSiteSeoContributions({
			titleSeparator: " | ",
			robotsTxt: "User-agent: *\nAllow: /",
		});

		expect(result).toEqual([]);
	});
});
