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

import type { ContentSeo } from "../../../src/database/repositories/types.js";
import { resolvePageMetadata } from "../../../src/page/metadata.js";
import {
	generateSeoPanelContributions,
	generateSiteSeoContributions,
} from "../../../src/page/seo-contributions.js";

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

/**
 * generateSeoPanelContributions() — #1518.
 *
 * Bug context: values set in the admin SEO panel were silently ignored
 * unless the template manually wired getSeoMeta(). EmDashHead now fetches
 * the panel row for content pages and inserts these contributions between
 * the plugin and base layers, so editor-set values apply by default.
 */
describe("generateSeoPanelContributions (#1518)", () => {
	const emptySeo: ContentSeo = {
		title: null,
		description: null,
		image: null,
		canonical: null,
		noIndex: false,
	};

	it("returns empty array when no panel field is set", () => {
		expect(generateSeoPanelContributions(emptySeo)).toEqual([]);
	});

	it("emits og:title and twitter:title for a panel title", () => {
		const result = generateSeoPanelContributions({ ...emptySeo, title: "Panel Title" });

		expect(result).toContainEqual({
			kind: "property",
			property: "og:title",
			content: "Panel Title",
		});
		expect(result).toContainEqual({
			kind: "meta",
			name: "twitter:title",
			content: "Panel Title",
		});
	});

	it("emits description, og:description, and twitter:description", () => {
		const result = generateSeoPanelContributions({ ...emptySeo, description: "Panel desc" });

		expect(result).toContainEqual({ kind: "meta", name: "description", content: "Panel desc" });
		expect(result).toContainEqual({
			kind: "property",
			property: "og:description",
			content: "Panel desc",
		});
		expect(result).toContainEqual({
			kind: "meta",
			name: "twitter:description",
			content: "Panel desc",
		});
	});

	it("resolves a bare media id image against siteUrl and upgrades the twitter card", () => {
		const result = generateSeoPanelContributions(
			{ ...emptySeo, image: "01KSMEDIA" },
			{ siteUrl: "https://example.com/" },
		);

		const expected = "https://example.com/_emdash/api/media/file/01KSMEDIA";
		expect(result).toContainEqual({ kind: "property", property: "og:image", content: expected });
		expect(result).toContainEqual({ kind: "meta", name: "twitter:image", content: expected });
		expect(result).toContainEqual({
			kind: "meta",
			name: "twitter:card",
			content: "summary_large_image",
		});
	});

	it("emits canonical link and og:url, absolutized against siteUrl", () => {
		const result = generateSeoPanelContributions(
			{ ...emptySeo, canonical: "/posts/other-post" },
			{ siteUrl: "https://example.com" },
		);

		const expected = "https://example.com/posts/other-post";
		expect(result).toContainEqual({ kind: "link", rel: "canonical", href: expected });
		expect(result).toContainEqual({ kind: "property", property: "og:url", content: expected });
	});

	it("passes an absolute canonical through unchanged", () => {
		const result = generateSeoPanelContributions(
			{ ...emptySeo, canonical: "https://other.example/page" },
			{ siteUrl: "https://example.com" },
		);

		expect(result).toContainEqual({
			kind: "link",
			rel: "canonical",
			href: "https://other.example/page",
		});
	});

	it("emits a robots noindex meta when noIndex is set", () => {
		const result = generateSeoPanelContributions({ ...emptySeo, noIndex: true });

		expect(result).toEqual([{ kind: "meta", name: "robots", content: "noindex, nofollow" }]);
	});

	it("wins over base contributions but loses to plugins under first-wins dedup", () => {
		const plugin = [{ kind: "meta", name: "description", content: "from plugin" } as const];
		const panel = generateSeoPanelContributions({
			...emptySeo,
			description: "from panel",
			title: "from panel",
		});
		const base = [
			{ kind: "meta", name: "description", content: "from template" } as const,
			{ kind: "property", property: "og:title", content: "from template" } as const,
		];

		const resolved = resolvePageMetadata([...plugin, ...panel, ...base]);

		expect(resolved.meta).toContainEqual({ name: "description", content: "from plugin" });
		expect(resolved.properties).toContainEqual({ property: "og:title", content: "from panel" });
	});
});
