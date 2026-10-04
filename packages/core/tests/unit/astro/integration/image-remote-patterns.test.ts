import type { AstroIntegration } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetEnvCache } from "../../../../src/api/public-url.js";
import {
	buildImageRemotePatterns,
	emdash,
	type EmDashConfig,
	imageEndpointRoutePattern,
	type ImageRemotePattern,
	resolveBuildTimeSiteUrl,
	resolveImageEndpoint,
} from "../../../../src/astro/integration/index.js";
import { RESOLVED_VIRTUAL_CONFIG_ID } from "../../../../src/astro/integration/virtual-modules.js";

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

	it("ignores a site URL whose hostname is a wildcard", () => {
		expect(buildImageRemotePatterns(localStorage, "https://*.example.com", "build")).toEqual([]);
		expect(buildImageRemotePatterns(localStorage, "https://**.com", "build")).toEqual([]);
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

describe("resolveBuildTimeSiteUrl", () => {
	const origEmdashSiteUrl = process.env.EMDASH_SITE_URL;
	const origSiteUrl = process.env.SITE_URL;

	beforeEach(() => {
		delete process.env.EMDASH_SITE_URL;
		delete process.env.SITE_URL;
		_resetEnvCache();
	});

	afterEach(() => {
		if (origEmdashSiteUrl === undefined) delete process.env.EMDASH_SITE_URL;
		else process.env.EMDASH_SITE_URL = origEmdashSiteUrl;
		if (origSiteUrl === undefined) delete process.env.SITE_URL;
		else process.env.SITE_URL = origSiteUrl;
		_resetEnvCache();
	});

	it("returns configured siteUrl when set", () => {
		expect(resolveBuildTimeSiteUrl("https://config.example.com")).toBe(
			"https://config.example.com",
		);
	});

	it("returns undefined when nothing is configured or set in env", () => {
		expect(resolveBuildTimeSiteUrl(undefined)).toBeUndefined();
	});

	it("falls back to EMDASH_SITE_URL", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com";
		expect(resolveBuildTimeSiteUrl(undefined)).toBe("https://env.example.com");
	});

	it("falls back to SITE_URL when EMDASH_SITE_URL is absent", () => {
		process.env.SITE_URL = "https://site.example.com";
		expect(resolveBuildTimeSiteUrl(undefined)).toBe("https://site.example.com");
	});

	it("prefers EMDASH_SITE_URL over SITE_URL", () => {
		process.env.EMDASH_SITE_URL = "https://emdash.example.com";
		process.env.SITE_URL = "https://site.example.com";
		expect(resolveBuildTimeSiteUrl(undefined)).toBe("https://emdash.example.com");
	});

	it("normalizes a path-bearing env var to its origin", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com/some/path?query=1";
		expect(resolveBuildTimeSiteUrl(undefined)).toBe("https://env.example.com");
	});

	it("ignores an unparseable env var", () => {
		process.env.EMDASH_SITE_URL = "not-a-url";
		expect(resolveBuildTimeSiteUrl(undefined)).toBeUndefined();
	});

	it("ignores a non-http(s) env var", () => {
		process.env.EMDASH_SITE_URL = "file:///etc/passwd";
		expect(resolveBuildTimeSiteUrl(undefined)).toBeUndefined();
	});

	it("prefers configured siteUrl over env vars", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com";
		expect(resolveBuildTimeSiteUrl("https://config.example.com")).toBe(
			"https://config.example.com",
		);
	});
});

describe("resolveImageEndpoint", () => {
	it("installs the Node endpoint on a stock/undefined endpoint", () => {
		expect(
			resolveImageEndpoint({
				imagesDisabled: false,
				currentEntrypoint: undefined,
				isCloudflare: false,
			}),
		).toEqual({ entrypoint: "emdash/internal/image-endpoint" });
		expect(
			resolveImageEndpoint({
				imagesDisabled: false,
				currentEntrypoint: "astro/assets/endpoint/generic",
				isCloudflare: false,
			}),
		).toEqual({ entrypoint: "emdash/internal/image-endpoint" });
	});

	it("installs the Cloudflare endpoint under the Cloudflare adapter", () => {
		expect(
			resolveImageEndpoint({
				imagesDisabled: false,
				currentEntrypoint: "@astrojs/cloudflare/image-transform-endpoint",
				isCloudflare: true,
			}),
		).toEqual({ entrypoint: "@emdash-cms/cloudflare/image-endpoint" });
	});

	it("skips silently when images are disabled", () => {
		expect(
			resolveImageEndpoint({
				imagesDisabled: true,
				currentEntrypoint: undefined,
				isCloudflare: true,
			}),
		).toEqual({});
	});

	it("leaves a deliberate passthrough endpoint alone without warning", () => {
		expect(
			resolveImageEndpoint({
				imagesDisabled: false,
				currentEntrypoint: "@astrojs/cloudflare/image-passthrough-endpoint",
				isCloudflare: true,
			}),
		).toEqual({});
	});

	it("warns and skips when a custom endpoint is configured", () => {
		const result = resolveImageEndpoint({
			imagesDisabled: false,
			currentEntrypoint: "./src/my-endpoint.ts",
			isCloudflare: false,
		});
		expect(result.entrypoint).toBeUndefined();
		expect(result.warn).toMatch(/custom image\.endpoint/);
	});
});

describe("imageEndpointRoutePattern", () => {
	it("drops the trailing slash of a trailingSlash: always endpoint route", () => {
		expect(imageEndpointRoutePattern("/_image/")).toBe("/_image");
	});
});

/** Runs `astro:config:setup` and returns the image config Astro would receive. */
async function imageConfigFor(config: EmDashConfig) {
	const setup = emdash(config).hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	const root = new URL("file:///tmp/emdash-image-endpoint-route/");
	await setup({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
		},
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	return (updateConfig.mock.calls[0]?.[0]?.image ?? {}) as {
		remotePatterns?: ImageRemotePattern[];
	};
}

/** Runs `astro:config:setup` and returns the config module the runtime would import. */
async function runtimeConfigFor(
	config: EmDashConfig,
	image: { endpoint?: { entrypoint?: string; route?: string } } = {},
) {
	const setup = emdash(config).hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	const root = new URL("file:///tmp/emdash-image-endpoint-route/");
	await setup({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
			image,
		},
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	const plugins = updateConfig.mock.calls.flatMap(([update]) => update?.vite?.plugins ?? []);
	const virtualModules = plugins.find(
		(plugin: { name?: string }) => plugin?.name === "emdash-virtual-modules",
	);
	const source = String(virtualModules.load(RESOLVED_VIRTUAL_CONFIG_ID));
	return JSON.parse(source.replace(/^export default /, "").replace(/;$/, "")) as {
		imageEndpointRoute?: string;
	};
}

describe("image remotePatterns from env", () => {
	const origEmdashSiteUrl = process.env.EMDASH_SITE_URL;
	const origSiteUrl = process.env.SITE_URL;

	beforeEach(() => {
		delete process.env.EMDASH_SITE_URL;
		delete process.env.SITE_URL;
		_resetEnvCache();
	});

	afterEach(() => {
		if (origEmdashSiteUrl === undefined) delete process.env.EMDASH_SITE_URL;
		else process.env.EMDASH_SITE_URL = origEmdashSiteUrl;
		if (origSiteUrl === undefined) delete process.env.SITE_URL;
		else process.env.SITE_URL = origSiteUrl;
		_resetEnvCache();
	});

	it("allowlists the EMDASH_SITE_URL origin for local media when no siteUrl is set", async () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com";
		const image = await imageConfigFor({});
		expect(image.remotePatterns).toContainEqual({
			hostname: "env.example.com",
			pathname: MEDIA_PATH,
		});
		expect(image.remotePatterns?.every((pattern) => pattern.hostname)).toBe(true);
	});

	it.each(["not-a-url", "file:///etc/passwd", "https://*.example.com", "https://**.com"])(
		"allowlists nothing for a malformed EMDASH_SITE_URL (%s)",
		async (value) => {
			process.env.EMDASH_SITE_URL = value;
			const image = await imageConfigFor({});
			expect(image.remotePatterns).toBeUndefined();
		},
	);
});

describe("image endpoint route in the runtime config", () => {
	it("records the route of the endpoint EmDash installs", async () => {
		expect((await runtimeConfigFor({})).imageEndpointRoute).toBe("/_image");
		expect(
			(await runtimeConfigFor({}, { endpoint: { route: "/media-transform/" } })).imageEndpointRoute,
		).toBe("/media-transform");
	});

	it("records no route when EmDash does not install its endpoint", async () => {
		expect((await runtimeConfigFor({ images: false })).imageEndpointRoute).toBeUndefined();
		expect(
			(await runtimeConfigFor({}, { endpoint: { entrypoint: "./src/my-endpoint.ts" } }))
				.imageEndpointRoute,
		).toBeUndefined();
	});
});
