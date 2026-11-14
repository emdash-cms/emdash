import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createAstro, createComponent, render } from "astro/runtime/server/index.js";
import {
	type DialectAdapter,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

import { requestCached } from "../../../src/request-cache.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

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
			rooms: null,
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
vi.mock(
	"virtual:emdash/dialect",
	() => ({ createDialect: vi.fn(), createCoalescingDialect: null, createRequestScopedDb }),
	{
		virtual: true,
	},
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
	EmDashRuntime: {
		create: async () =>
			new Proxy(MOCK_RUNTIME, {
				get: (runtime, key) =>
					key === "then"
						? undefined
						: key in runtime
							? Reflect.get(runtime, key)
							: async () => ({ success: true }),
			}),
	},
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

function htmlNavigation(
	path = "/posts/hello",
	locals: Record<string, unknown> = {},
	properties: Record<string, unknown> = {},
) {
	return {
		request: new Request(`https://example.com${path}`, {
			headers: { accept: "text/html,application/xhtml+xml" },
		}),
		url: new URL(`https://example.com${path}`),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals,
		...properties,
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
	let realDb: Awaited<ReturnType<typeof setupTestDatabase>>;
	let queryCount: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		realDb = await setupTestDatabase();
		Object.defineProperty(realDb.getExecutor().adapter, "supportsMultipleConnections", {
			value: true,
		});
		queryCount = vi.spyOn(realDb.getExecutor(), "executeQuery");
	});

	afterAll(async () => {
		queryCount.mockRestore();
		await teardownTestDatabase(realDb);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		queryCount.mockClear();
		prefetchLayoutData.mockImplementation(() =>
			requestCached("rewrite-layout", async () =>
				realDb.selectFrom("_emdash_migrations").selectAll().limit(1).execute(),
			).then(() => undefined),
		);
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

	async function rewrite(
		options: {
			targetLocals?: Record<string, unknown>;
			targetPath?: string;
			targetProperties?: Record<string, unknown>;
		} = {},
	) {
		const scope = { db: realDb, commit: vi.fn(), close: vi.fn() };
		createRequestScopedDb.mockReturnValue(scope);
		const original = htmlNavigation("/missing-page");
		const response = await onRequest(original, async () => {
			await requestCached("rewrite-layout", async () =>
				realDb.selectFrom("_emdash_migrations").selectAll().limit(1).execute(),
			);
			const target = htmlNavigation(
				options.targetPath ?? "/404",
				options.targetLocals ?? original.locals,
				options.targetProperties,
			);
			return onRequest(target, async () => {
				await requestCached("rewrite-layout", async () =>
					realDb.selectFrom("_emdash_migrations").selectAll().limit(1).execute(),
				);
				return new Response("ok");
			});
		});
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 10));
		return scope;
	}

	it("does not repeat layout reads through Astro's real rewrite pipeline", async () => {
		const scope = { db: realDb, commit: vi.fn(), close: vi.fn() };
		createRequestScopedDb.mockReturnValue(scope);
		const read = () =>
			requestCached("rewrite-layout", async () =>
				realDb.selectFrom("_emdash_migrations").selectAll().limit(1).execute(),
			);
		const notFound = createComponent(async (result, props, slots) => {
			const Astro = result.createAstro(createAstro(), props, slots);
			Astro.response.status = 404;
			await read();
			return render`<html><body>Not found</body></html>`;
		});
		const missing = createComponent(async (result, props, slots) => {
			const Astro = result.createAstro(createAstro(), props, slots);
			await read();
			return Astro.rewrite("/404");
		});
		const container = await AstroContainer.create({
			manifest: {
				middleware: async () => ({ onRequest }),
			} as NonNullable<Parameters<typeof AstroContainer.create>[0]>["manifest"],
		});
		container.insertPageRoute("/404", notFound);
		const direct = await container.renderToResponse(notFound, {
			request: new Request("https://example.com/404", { headers: { accept: "text/html" } }),
		});
		expect(direct.status).toBe(404);
		await direct.text();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const directQueries = queryCount.mock.calls.length;
		vi.clearAllMocks();
		const rewritten = await container.renderToResponse(missing, {
			request: new Request("https://example.com/missing-page", {
				headers: { accept: "text/html" },
			}),
		});
		expect(rewritten.status).toBe(404);
		expect(await rewritten.text()).toContain("Not found");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(directQueries).toBe(1);
		expect(queryCount).toHaveBeenCalledTimes(directQueries);
		expect(prefetchLayoutData).toHaveBeenCalledOnce();
		expect(createRequestScopedDb).toHaveBeenCalledOnce();
		expect(scope.commit).toHaveBeenCalledOnce();
		expect(scope.close).toHaveBeenCalledOnce();
	});

	it("reuses the prefetched layout read for an anonymous rewrite", async () => {
		const scope = await rewrite();

		expect(queryCount).toHaveBeenCalledOnce();
		expect(prefetchLayoutData).toHaveBeenCalledOnce();
		expect(createRequestScopedDb).toHaveBeenCalledOnce();
		expect(scope.commit).toHaveBeenCalledOnce();
		expect(scope.close).toHaveBeenCalledOnce();
	});

	it("does not reuse the cache across independent requests", async () => {
		await rewrite();
		await rewrite();

		expect(queryCount).toHaveBeenCalledTimes(2);
		expect(prefetchLayoutData).toHaveBeenCalledTimes(2);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
	});

	it("does not reuse the cache when the rewrite has different locals", async () => {
		await rewrite({ targetLocals: {} });

		expect(queryCount).toHaveBeenCalledTimes(2);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
	});

	it("does not reuse the cache for a different locale target", async () => {
		await rewrite({ targetProperties: { currentLocale: "fr" } });

		expect(queryCount).toHaveBeenCalledTimes(2);
	});

	it.each(["/_emdash/api/content", "/sitemap.xml"])(
		"initializes runtime handlers for a rewrite to %s",
		async (targetPath) => {
			await rewrite({ targetPath });
			expect(queryCount).toHaveBeenCalledTimes(2);
			expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
		},
	);

	it("does not reuse the cache for a preview target", async () => {
		await rewrite({ targetPath: "/404?_preview=1" });

		expect(queryCount).toHaveBeenCalledTimes(2);
	});

	it("closes the scoped database when the rewritten render fails", async () => {
		const scope = { db: realDb, commit: vi.fn(), close: vi.fn() };
		createRequestScopedDb.mockReturnValue(scope);
		const original = htmlNavigation("/missing-page");
		await expect(
			onRequest(original, async () =>
				onRequest(htmlNavigation("/404", original.locals, {}), async () => {
					throw new Error("render failed");
				}),
			),
		).rejects.toThrow("render failed");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(createRequestScopedDb).toHaveBeenCalledOnce();
		expect(scope.commit).toHaveBeenCalledOnce();
		expect(scope.close).toHaveBeenCalledOnce();
	});
});
