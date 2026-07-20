import { describe, it, expect } from "vitest";

import { getSeoMeta } from "../../../src/seo/index.js";

// Lightweight unit tests for the getSeoMeta + buildMediaUrl path.
// These don't touch the DB — they exercise the URL-building logic
// directly via getSeoMeta's ogImage output.

describe("getSeoMeta ogImage URL building", () => {
	const SITE = "https://example.com";

	it("returns absolute URLs as-is (no prefix doubling)", () => {
		const meta = getSeoMeta(
			{ seo: { image: "https://cdn.example.com/x.jpg" }, data: {} },
			{ siteUrl: SITE },
		);
		expect(meta.ogImage).toBe("https://cdn.example.com/x.jpg");
	});

	it("joins root-relative paths with siteUrl without re-prefixing the API path", () => {
		// Regression test: the CMS SEO panel stores seo_image as a
		// root-relative path that already includes /_emdash/api/media/file/.
		// Before the fix this produced "...media/file//_emdash/api/media/file/..."
		const meta = getSeoMeta(
			{ seo: { image: "/_emdash/api/media/file/01KS.svg" }, data: {} },
			{ siteUrl: SITE },
		);
		expect(meta.ogImage).toBe("https://example.com/_emdash/api/media/file/01KS.svg");
		expect(meta.ogImage).not.toContain("//_emdash");
	});

	it("returns root-relative paths as-is when no siteUrl is provided", () => {
		const meta = getSeoMeta({ seo: { image: "/_emdash/api/media/file/01KS.svg" }, data: {} }, {});
		expect(meta.ogImage).toBe("/_emdash/api/media/file/01KS.svg");
	});

	it("builds the full API path from a bare media_id", () => {
		const meta = getSeoMeta({ seo: { image: "01KS" }, data: {} }, { siteUrl: SITE });
		expect(meta.ogImage).toBe("https://example.com/_emdash/api/media/file/01KS");
	});

	it("strips trailing slash from siteUrl before joining a root-relative path", () => {
		const meta = getSeoMeta(
			{ seo: { image: "/_emdash/api/media/file/01KS.svg" }, data: {} },
			{ siteUrl: "https://example.com/" },
		);
		expect(meta.ogImage).toBe("https://example.com/_emdash/api/media/file/01KS.svg");
	});
});

describe("getSeoMeta defaultTitle / defaultDescription (#1518)", () => {
	const entry = {
		data: { title: "Raw Title", excerpt: "Raw excerpt" },
	};

	it("uses computed defaults over data.title / data.excerpt", () => {
		const meta = getSeoMeta(entry, {
			defaultTitle: "Raw Title (cover of Artist)",
			defaultDescription: "A computed description",
		});
		expect(meta.title).toBe("Raw Title (cover of Artist)");
		expect(meta.description).toBe("A computed description");
	});

	it("lets an editor-set SEO panel value win over the caller default", () => {
		const meta = getSeoMeta(
			{
				data: {
					...entry.data,
					seo: { title: "Panel Title", description: "Panel description" },
				},
			},
			{
				defaultTitle: "Computed default",
				defaultDescription: "Computed description",
			},
		);
		expect(meta.title).toBe("Panel Title");
		expect(meta.description).toBe("Panel description");
	});

	it("still falls back to data.title / data.excerpt without defaults", () => {
		const meta = getSeoMeta(entry, {});
		expect(meta.title).toBe("Raw Title");
		expect(meta.description).toBe("Raw excerpt");
	});

	it("applies the siteTitle suffix to the default title", () => {
		const meta = getSeoMeta(entry, { defaultTitle: "Computed", siteTitle: "My Site" });
		expect(meta.title).toBe("Computed | My Site");
	});
});
