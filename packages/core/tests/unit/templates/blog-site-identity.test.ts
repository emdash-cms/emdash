import { describe, expect, it } from "vitest";

import { resolveBlogSiteIdentity as resolveBlogSiteIdentityCloudflare } from "../../../../../templates/blog-cloudflare/src/utils/site-identity";
import { resolveBlogSiteIdentity as resolveBlogSiteIdentityNode } from "../../../../../templates/blog/src/utils/site-identity";

describe("blog template site identity", () => {
	it("uses CMS site title and tagline when provided", () => {
		// Favicon is intentionally absent from the helper return: core's
		// EmDashHead now emits the favicon link via renderSiteIdentity()
		// (#831), so the template no longer needs to surface it.
		const settings = {
			title: "Example Site",
			tagline: "Writing about shipping software",
			logo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
			favicon: { mediaId: "fav-1", url: "/_emdash/api/media/file/favicon.svg" },
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Writing about shipping software",
			siteLogo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Writing about shipping software",
			siteLogo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
		});
	});

	it("falls back to the bundled blog defaults when settings are missing", () => {
		expect(resolveBlogSiteIdentityNode({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
			siteLogo: null,
		});
		expect(resolveBlogSiteIdentityCloudflare({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
			siteLogo: null,
		});
	});

	it("preserves intentionally blank settings instead of restoring defaults", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
			siteLogo: "",
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
		});
	});

	it("returns null for logo without resolved URL", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
			logo: { mediaId: "logo-1" },
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
		});
	});
});
