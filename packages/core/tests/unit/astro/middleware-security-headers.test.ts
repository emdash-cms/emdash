/**
 * Regression tests for issue #1393: `finalizeResponse()` unconditionally set
 * `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` on every
 * response. Because the middleware registers with `order: 'pre'` (#1282), on the
 * response path it runs *after* the host app's own middleware, so it overwrote
 * any of these headers the host had already set. CSP was handled defensively
 * (`if (!res.headers.has(...))`) but these three were not.
 *
 * The fix applies the baseline headers set-if-absent, matching the existing CSP
 * pattern, so a host that sets a stricter value on its own public routes wins.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { DB_CONFIG_MARKER } = vi.hoisted(() => ({
	DB_CONFIG_MARKER: { binding: "DB", session: "auto" },
}));

const { MOCK_RUNTIME, mockGetPublicUrl } = vi.hoisted(() => {
	const ok = async () => ({ success: true });
	const getPublicUrl = vi.fn((key: string) => `https://media.example.com/${key}`);
	return {
		MOCK_RUNTIME: {
			storage: { getPublicUrl },
			db: {},
			hooks: {},
			email: null,
			configuredPlugins: [],
			handleContentList: ok,
			handleContentGet: ok,
			handleContentCreate: ok,
			handleContentUpdate: ok,
			handleContentDelete: ok,
			handleContentListTrashed: ok,
			handleContentRestore: ok,
			handleContentPermanentDelete: ok,
			handleContentCountTrashed: ok,
			handleContentGetIncludingTrashed: ok,
			handleContentDuplicate: ok,
			handleContentPublish: ok,
			handleContentUnpublish: ok,
			handleContentSchedule: ok,
			handleContentUnschedule: ok,
			handleContentCountScheduled: ok,
			handleContentDiscardDraft: ok,
			handleContentCompare: ok,
			handleContentTranslations: ok,
			handleMediaList: ok,
			handleMediaGet: ok,
			handleMediaCreate: ok,
			handleMediaUpdate: ok,
			handleMediaDelete: ok,
			handleRevisionList: ok,
			handleRevisionGet: ok,
			handleRevisionRestore: ok,
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
		},
		mockGetPublicUrl: getPublicUrl,
	};
});

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: { config: DB_CONFIG_MARKER },
			auth: { mode: "none" },
		},
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn().mockReturnValue(null),
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({
		createSandboxRunner: null,
		sandboxBypassed: false,
		sandboxEnabled: false,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }), { virtual: true });

vi.mock("../../../src/emdash-runtime.js", () => ({
	DB_INIT_DEADLINE_MS: 30_000,
	EmDashRuntime: {
		create: async () => MOCK_RUNTIME,
	},
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({
			selectAll: () => ({
				limit: () => ({
					execute: async () => [],
				}),
			}),
		}),
	})),
}));

import { createRequestScopedDb } from "virtual:emdash/dialect";

import onRequest from "../../../src/astro/middleware.js";

/** Anonymous GET to a public frontend page (the `runAnon` response path). */
function anonymousPublicPageContext() {
	const cookies = {
		get: vi.fn((name: string) => {
			if (name === "astro-session") return undefined;
			return undefined;
		}),
		set: vi.fn(),
	};
	const astroSession = { get: vi.fn(async () => null) };

	return {
		request: new Request("https://example.com/contact"),
		url: new URL("https://example.com/contact"),
		cookies,
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: astroSession,
	} as Record<string, unknown>;
}

describe("astro middleware baseline security headers (issue #1393)", () => {
	beforeEach(() => {
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		mockGetPublicUrl.mockClear();
	});

	it("does not overwrite host-set security headers on public routes", async () => {
		const context = anonymousPublicPageContext();
		const hostHeaders = {
			"Permissions-Policy":
				"camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		};

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok", { headers: hostHeaders }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Permissions-Policy")).toBe(hostHeaders["Permissions-Policy"]);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("still applies EmDash baseline headers when the host sets none", async () => {
		const context = anonymousPublicPageContext();

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
		expect(response.headers.get("Permissions-Policy")).toBe(
			"camera=(), microphone=(), geolocation=(), payment=()",
		);
	});
});
