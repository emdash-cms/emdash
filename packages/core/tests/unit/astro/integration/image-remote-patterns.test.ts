import { describe, expect, it } from "vitest";

import { buildImageRemotePatterns } from "../../../../src/astro/integration/index.js";

const s3 = (publicUrl?: string) => ({ entrypoint: "x", config: { publicUrl } });
const localStorage = { entrypoint: "x", config: { directory: "./uploads" } };
const MEDIA_PATH = "/_emdash/api/media/file/**";

describe("buildImageRemotePatterns", () => {
	it("authorizes the storage public URL host", () => {
		expect(buildImageRemotePatterns(s3("https://cdn.example.com"), undefined, "build")).toEqual([
			{ protocol: "https", hostname: "cdn.example.com" },
		]);
	});

	it("scopes the pattern to the public URL path prefix when present", () => {
		expect(
			buildImageRemotePatterns(s3("https://cdn.example.com/assets"), undefined, "build"),
		).toEqual([{ protocol: "https", hostname: "cdn.example.com", pathname: "/assets/**" }]);
	});

	it("normalizes a trailing slash on the path prefix", () => {
		expect(
			buildImageRemotePatterns(s3("https://cdn.example.com/assets/"), undefined, "build"),
		).toEqual([{ protocol: "https", hostname: "cdn.example.com", pathname: "/assets/**" }]);
	});

	it("ignores a non-http(s) public URL", () => {
		expect(buildImageRemotePatterns(s3("ftp://files.example.com"), undefined, "build")).toEqual([]);
	});

	it("ignores an unparseable public URL", () => {
		expect(buildImageRemotePatterns(s3("not a url"), undefined, "build")).toEqual([]);
	});

	it("authorizes the site origin scoped to the media route when siteUrl is set", () => {
		expect(buildImageRemotePatterns(localStorage, "https://example.com", "build")).toEqual([
			{ hostname: "example.com", pathname: MEDIA_PATH },
		]);
	});

	it("adds a host-agnostic media pattern only in dev", () => {
		expect(buildImageRemotePatterns(localStorage, undefined, "dev")).toEqual([
			{ pathname: MEDIA_PATH },
		]);
		expect(buildImageRemotePatterns(localStorage, undefined, "build")).toEqual([]);
	});

	it("combines CDN, site-origin, and dev patterns", () => {
		expect(
			buildImageRemotePatterns(s3("https://cdn.example.com"), "https://example.com", "dev"),
		).toEqual([
			{ protocol: "https", hostname: "cdn.example.com" },
			{ hostname: "example.com", pathname: MEDIA_PATH },
			{ pathname: MEDIA_PATH },
		]);
	});
});
