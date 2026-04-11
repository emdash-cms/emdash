import { describe, expect, it } from "vitest";

import { resolveBlogSiteIdentity as resolveBlogSiteIdentityCloudflare } from "../../../../../templates/blog-cloudflare/src/utils/site-identity";
import { resolveBlogSiteIdentity as resolveBlogSiteIdentityNode } from "../../../../../templates/blog/src/utils/site-identity";

describe("blog template site identity", () => {
	it("uses CMS site title and tagline when provided", () => {
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
			siteFavicon: "/_emdash/api/media/file/favicon.svg",
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Writing about shipping software",
			siteLogo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
			siteFavicon: "/_emdash/api/media/file/favicon.svg",
		});
	});

	it("falls back to the bundled blog defaults when settings are missing", () => {
		expect(resolveBlogSiteIdentityNode({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
			siteFavicon: null,
			siteLogo: null,
		});
		expect(resolveBlogSiteIdentityCloudflare({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
			siteFavicon: null,
			siteLogo: null,
		});
	});

	it("preserves intentionally blank settings instead of restoring defaults", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
			siteFavicon: "",
			siteLogo: "",
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteFavicon: null,
			siteLogo: null,
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteFavicon: null,
			siteLogo: null,
		});
	});

	it("returns null for logo/favicon without resolved URL", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
			logo: { mediaId: "logo-1" },
			favicon: { mediaId: "fav-1" },
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
			siteFavicon: null,
		});
	});
});
