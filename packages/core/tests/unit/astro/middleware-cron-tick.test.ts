/**
 * Piggyback cron tick on public requests (issue #1422).
 *
 * On platforms without a dedicated scheduler (Cloudflare Workers), cron
 * execution relies on the PiggybackScheduler being driven from the request
 * path via `runtime.tickCron()`. The bug: `tickCron()` existed but had no
 * call sites, so plugin cron tasks never ran on Workers — overdue tasks sat
 * at `status = idle` forever.
 *
 * These tests pin the contract: a public page request must tick the cron
 * system exactly once (the scheduler debounces internally).
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

// vi.mock factories are hoisted above normal `const` declarations; use
// vi.hoisted so the marker objects are available to both the factories and
// the assertions below.
const { DB_CONFIG_MARKER } = vi.hoisted(() => ({
	DB_CONFIG_MARKER: { binding: "DB", session: "auto" },
}));

const { MOCK_RUNTIME, mockTickCron } = vi.hoisted(() => {
	const ok = async () => ({ success: true });
	const tickCron = vi.fn();

	return {
		MOCK_RUNTIME: {
			storage: { getPublicUrl: (key: string) => `https://media.example.com/${key}` },
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
			handlePluginApiRoute: ok,
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
			tickCron,
		},
		mockTickCron: tickCron,
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

import onRequest from "../../../src/astro/middleware.js";

function anonymousPublicPageContext() {
	const cookies = {
		get: vi.fn(() => undefined),
		set: vi.fn(),
	};
	return {
		request: new Request("https://example.com/blog/hello"),
		url: new URL("https://example.com/blog/hello"),
		cookies,
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
	} as Record<string, unknown>;
}

describe("astro middleware piggyback cron tick", () => {
	beforeEach(() => {
		mockTickCron.mockClear();
	});

	it("ticks the cron system on anonymous public page requests", async () => {
		const context = anonymousPublicPageContext();

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		// One tick per request — the scheduler debounces internally, so the
		// middleware must not try to be clever about frequency.
		expect(mockTickCron).toHaveBeenCalledTimes(1);
	});

	it("ticks once per request on the full runtime path too", async () => {
		// Prerendered public runtime routes take the full-runtime branch of the
		// middleware — the tick must happen there as well (it is a no-op unless
		// the platform actually uses the PiggybackScheduler).
		const context = anonymousPublicPageContext();
		(context as { isPrerendered: boolean }).isPrerendered = true;

		await onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok"));

		expect(mockTickCron).toHaveBeenCalledTimes(1);
	});
});
