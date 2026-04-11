import { describe, expect, it } from "vitest";

import { resolveStarterSiteIdentity as resolveStarterSiteIdentityCloudflare } from "../../../../../templates/starter-cloudflare/src/utils/site-identity";
import { resolveStarterSiteIdentity as resolveStarterSiteIdentityNode } from "../../../../../templates/starter/src/utils/site-identity";

describe("starter template site identity", () => {
	it("uses CMS site title and tagline when provided", () => {
		const settings = {
			title: "Example Site",
			tagline: "Shipping notes",
		};

		expect(resolveStarterSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Shipping notes",
		});
		expect(resolveStarterSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Shipping notes",
		});
	});

	it("falls back to starter defaults when settings are missing", () => {
		expect(resolveStarterSiteIdentityNode({})).toEqual({
			siteTitle: "My Site",
			siteTagline: "Built with EmDash",
		});
		expect(resolveStarterSiteIdentityCloudflare({})).toEqual({
			siteTitle: "My Site",
			siteTagline: "Built with EmDash",
		});
	});

	it("preserves intentionally blank taglines", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
		};

		expect(resolveStarterSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
		});
		expect(resolveStarterSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
		});
	});
});
