import { describe, expect, it } from "vitest";

import { resolveBlogSiteIdentity as resolveBlogSiteIdentityCloudflare } from "../../../../../templates/blog-cloudflare/src/utils/site-identity";
import { resolveBlogSiteIdentity as resolveBlogSiteIdentityNode } from "../../../../../templates/blog/src/utils/site-identity";

describe("blog template site identity", () => {
	it("uses CMS site title and tagline when provided", () => {
		const settings = {
			title: "Example Site",
			tagline: "Writing about shipping software",
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Writing about shipping software",
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "Writing about shipping software",
		});
	});

	it("falls back to the bundled blog defaults when settings are missing", () => {
		expect(resolveBlogSiteIdentityNode({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
		});
		expect(resolveBlogSiteIdentityCloudflare({})).toEqual({
			siteTitle: "My Blog",
			siteTagline: "Thoughts, stories, and ideas.",
		});
	});

	it("preserves intentionally blank settings instead of restoring defaults", () => {
		const settings = {
			title: "Example Site",
			tagline: "",
		};

		expect(resolveBlogSiteIdentityNode(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
		});
		expect(resolveBlogSiteIdentityCloudflare(settings)).toEqual({
			siteTitle: "Example Site",
			siteTagline: "",
		});
	});
});
