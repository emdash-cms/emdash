import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { BUILD_TIME, MOCK_RUNTIME } = vi.hoisted(() => {
	const ok = async () => ({ success: true });
	return {
		BUILD_TIME: Date.parse("2026-08-07T22:26:49.000Z"),
		MOCK_RUNTIME: {
			storage: { getPublicUrl: vi.fn((key: string) => `https://media.example.com/${key}`) },
			db: {},
			hooks: {},
			email: null,
			configuredPlugins: [],
			getPluginRouteMeta: () => null,
			handlePluginApiRoute: async () => ({ success: true }),
			getMediaProvider: () => undefined,
			getMediaProviderList: () => [],
			collectPageMetadata: async () => [],
			collectPageFragments: async () => [],
			ensureSearchHealthy: async () => undefined,
			getManifest: async () => ({}),
			getSandboxRunner: () => null,
			isSandboxBypassed: () => false,
			syncMarketplacePlugins: async () => undefined,
			syncRegistryPlugins: async () => undefined,
			setPluginStatus: async () => undefined,
			handleContentList: ok,
		},
	};
});

vi.mock("virtual:emdash/build", () => ({ buildTime: BUILD_TIME }), { virtual: true });
vi.mock(
	"virtual:emdash/config",
	() => ({ default: { database: { config: { binding: "DB" } }, auth: { mode: "none" } } }),
	{ virtual: true },
);
vi.mock(
	"virtual:emdash/dialect",
	() => ({ createDialect: vi.fn(), createRequestScopedDb: vi.fn().mockReturnValue(null) }),
	{ virtual: true },
);
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({ createSandboxRunner: null, sandboxBypassed: false, sandboxEnabled: false }),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }), { virtual: true });

vi.mock("../../../src/emdash-runtime.js", () => ({
	DB_INIT_DEADLINE_MS: 30_000,
	EmDashRuntime: { create: async () => MOCK_RUNTIME },
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({ selectAll: () => ({ limit: () => ({ execute: async () => [] }) }) }),
	})),
}));

import onRequest from "../../../src/astro/middleware.js";

interface CacheInput {
	maxAge?: number;
	lastModified?: Date;
	tags?: string[];
}

/**
 * Stand-in for Astro's `AstroCache`, mirroring the accumulation rules the real
 * one applies in `core/cache/runtime/cache.js`: `lastModified` keeps the later
 * date, `set(false)` clears accumulated state, and any later `set()` re-enables.
 */
function createCache(enabled = true) {
	let disabled = false;
	const options: CacheInput = {};
	return {
		enabled,
		set(input: CacheInput | false) {
			if (input === false) {
				disabled = true;
				delete options.maxAge;
				delete options.lastModified;
				delete options.tags;
				return;
			}
			disabled = false;
			if (input.maxAge !== undefined) options.maxAge = input.maxAge;
			if (
				input.lastModified &&
				(!options.lastModified || input.lastModified > options.lastModified)
			) {
				options.lastModified = input.lastModified;
			}
			if (input.tags) options.tags = [...(options.tags ?? []), ...input.tags];
		},
		get disabled() {
			return disabled;
		},
		get options() {
			return options;
		},
	};
}

type TestCache = ReturnType<typeof createCache>;

function anonymousPublicPageContext(cache: TestCache) {
	return {
		request: new Request("https://example.com/posts/hello"),
		url: new URL("https://example.com/posts/hello"),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
		cache,
	} as Record<string, unknown>;
}

/** A page rendering with `Astro.cache.set(cacheHint)`, as the demos do. */
function pageSetting(cache: TestCache, hint: CacheInput | false) {
	return async () => {
		cache.set(hint);
		return new Response("<html></html>", { headers: { "content-type": "text/html" } });
	};
}

describe("astro middleware cache validator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("raises a content-only validator to the build time", async () => {
		const cache = createCache();
		const contentModified = new Date(BUILD_TIME - 6 * 60 * 60 * 1000);

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			pageSetting(cache, { lastModified: contentModified, tags: ["posts"] }),
		);

		expect(cache.options.lastModified?.getTime()).toBe(BUILD_TIME);
	});

	it("does not give a page with only a route rule a validator that publishing cannot move", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
		);

		expect(cache.options.lastModified).toBeUndefined();
	});

	it("does not give a page with only tag hints a validator that publishing cannot move", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			pageSetting(cache, { tags: ["site-settings"] }),
		);

		expect(cache.options.lastModified).toBeUndefined();
	});

	it("leaves a route that opts out of caching opted out", async () => {
		const cache = createCache();

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			pageSetting(cache, false),
		);

		expect(cache.disabled).toBe(true);
		expect(cache.options.lastModified).toBeUndefined();
	});

	it("leaves prerendered requests to the host's static layer", async () => {
		const cache = createCache();
		const context = anonymousPublicPageContext(cache);
		context.isPrerendered = true;

		await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
		);

		expect(cache.options.lastModified).toBeUndefined();
	});

	it("does not touch the cache when no provider is configured", async () => {
		const cache = createCache(false);

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
		);

		expect(cache.options.lastModified).toBeUndefined();
	});
});

describe("astro middleware route cache sharing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps an anonymous page with a route rule cacheable", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });

		await onRequest(
			anonymousPublicPageContext(cache) as Parameters<typeof onRequest>[0],
			pageSetting(cache, { tags: ["posts"] }),
		);

		expect(cache.disabled).toBe(false);
	});

	it("keeps a page rendered for a signed-in user out of the shared cache", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });
		const context = anonymousPublicPageContext(cache);
		context.cookies = {
			get: vi.fn((name: string) => (name === "astro-session" ? { value: "s1" } : undefined)),
			set: vi.fn(),
		};
		const locals = context.locals as Record<string, unknown>;
		const renderPage = pageSetting(cache, { tags: ["posts"] });

		await onRequest(context as Parameters<typeof onRequest>[0], async () => {
			locals.user = { id: "u1", role: 10 };
			return renderPage();
		});

		expect(cache.disabled).toBe(true);
	});

	it("keeps a public media file requested anonymously cacheable", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });
		const context = anonymousPublicPageContext(cache);
		context.request = new Request("https://example.com/_emdash/api/media/file/photo.jpg");
		context.url = new URL("https://example.com/_emdash/api/media/file/photo.jpg");

		await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () =>
				new Response("image", {
					headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" },
				}),
		);

		expect(cache.disabled).toBe(false);
	});

	it("keeps a private response out of the shared cache when a route rule matches it", async () => {
		const cache = createCache();
		cache.set({ maxAge: 300 });
		const context = anonymousPublicPageContext(cache);
		context.request = new Request("https://example.com/_emdash/api/content/posts");
		context.url = new URL("https://example.com/_emdash/api/content/posts");

		await onRequest(context as Parameters<typeof onRequest>[0], async () =>
			Response.json(
				{ success: false, error: { code: "NOT_AUTHENTICATED", message: "" } },
				{ status: 401, headers: { "Cache-Control": "private, no-store" } },
			),
		);

		expect(cache.disabled).toBe(true);
	});
});
