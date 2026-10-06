import {
	type DialectAdapter,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME, createRequestScopedDb, prefetchLayoutData } = vi.hoisted(() => {
	const ok = async () => ({ success: true });
	return {
		createRequestScopedDb: vi.fn(),
		prefetchLayoutData: vi.fn(async () => undefined),
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

vi.mock(
	"virtual:emdash/config",
	() => ({ default: { database: { config: { binding: "DB" } }, auth: { mode: "none" } } }),
	{ virtual: true },
);
vi.mock("virtual:emdash/dialect", () => ({ createDialect: vi.fn(), createRequestScopedDb }), {
	virtual: true,
});
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

vi.mock("../../../src/astro/prefetch.js", () => ({ prefetchLayoutData }));

import onRequest from "../../../src/astro/middleware.js";

function kyselyWith(adapter: DialectAdapter) {
	return new Kysely({
		dialect: {
			createAdapter: () => adapter,
			createDriver: () => new DummyDriver(),
			createIntrospector: (db) => new SqliteIntrospector(db),
			createQueryCompiler: () => new SqliteQueryCompiler(),
		},
	});
}

function htmlNavigation() {
	return {
		request: new Request("https://example.com/posts/hello", {
			headers: { accept: "text/html,application/xhtml+xml" },
		}),
		url: new URL("https://example.com/posts/hello"),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
	} as unknown as Parameters<typeof onRequest>[0];
}

async function navigate() {
	await onRequest(
		htmlNavigation(),
		async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("layout prefetch on anonymous HTML navigations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const adapterWithoutFlag: DialectAdapter = {
		acquireMigrationLock: async () => undefined,
		releaseMigrationLock: async () => undefined,
	};

	it.each([
		["multiple connections", new PostgresAdapter()],
		["no connection flag", adapterWithoutFlag],
	])("prefetches when the request-scoped adapter reports %s", async (_label, adapter) => {
		createRequestScopedDb.mockReturnValue({ db: kyselyWith(adapter), commit: vi.fn() });

		await navigate();

		expect(prefetchLayoutData).toHaveBeenCalledOnce();
	});

	it("skips the prefetch when the request-scoped db runs one query at a time", async () => {
		createRequestScopedDb.mockReturnValue({ db: kyselyWith(new SqliteAdapter()), commit: vi.fn() });

		await navigate();

		expect(createRequestScopedDb).toHaveBeenCalled();
		expect(prefetchLayoutData).not.toHaveBeenCalled();
	});
});
