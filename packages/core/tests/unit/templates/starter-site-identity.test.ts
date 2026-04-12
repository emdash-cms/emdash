import { describe, expect, it } from "vitest";

import { resolveStarterSiteIdentity as resolveStarterSiteIdentityCloudflare } from "../../../../../templates/starter-cloudflare/src/utils/site-identity";
import { resolveStarterSiteIdentity as resolveStarterSiteIdentityNode } from "../../../../../templates/starter/src/utils/site-identity";

describe("starter template site identity", () => {
	it("uses CMS site title and tagline when provided", () => {
		const settings = {
			title: "Example Site",
			tagline: "Shipping notes",
			logo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
			favicon: { mediaId: "fav-1", url: "/_emdash/api/media/file/favicon.svg" },
		};

		expect(resolveStarterSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Shipping notes",
			siteLogo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
			siteFavicon: "/_emdash/api/media/file/favicon.svg",
		});
		expect(resolveStarterSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Shipping notes",
			siteLogo: { mediaId: "logo-1", alt: "My Logo", url: "/_emdash/api/media/file/logo.webp" },
			siteFavicon: "/_emdash/api/media/file/favicon.svg",
		});
	});

	it("falls back to starter defaults when settings are missing", () => {
		expect(resolveStarterSiteIdentityNode({})).toEqual({
			siteTitle: "My Site",
			siteTagline: "Built with EmDash",
			siteLogo: null,
			siteFavicon: null,
		});
		expect(resolveStarterSiteIdentityCloudflare({})).toEqual({
			siteTitle: "My Site",
			siteTagline: "Built with EmDash",
			siteLogo: null,
			siteFavicon: null,
		});
	});

	it("returns null for logo/favicon without resolved URL", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
			logo: { mediaId: "logo-1" },
			favicon: { mediaId: "fav-1" },
		};

		expect(resolveStarterSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
			siteFavicon: null,
		});
		expect(resolveStarterSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
			siteLogo: null,
			siteFavicon: null,
		});
	});
});
