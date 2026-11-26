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
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	it,
	expect,
	onTestFinished,
	vi,
} from "vitest";

import { MenuRepository } from "../../../src/database/repositories/menu.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { type I18nConfig, setI18nConfig } from "../../../src/i18n/config.js";
import { getMenu } from "../../../src/menus/index.js";
import { requestCached } from "../../../src/request-cache.js";
import { getTaxonomyTerms, resetTaxonomyDefsCacheForTests } from "../../../src/taxonomies/index.js";
import {
	setupTestDatabase,
	setupTestDatabaseWithCollections,
	teardownTestDatabase,
} from "../../utils/test-db.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME, createRequestScopedDb, getDb, prefetchLayoutData } = vi.hoisted(() => {
	const ok = async () => ({ success: true });
	return {
		createRequestScopedDb: vi.fn(),
		getDb: vi.fn(),
		prefetchLayoutData: vi.fn<(locale?: string) => Promise<void>>(async () => undefined),
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
	() => ({
		default: {
			database: { config: { binding: "DB" } },
			auth: { mode: "none" },
			i18n: { defaultLocale: "cs", locales: ["cs", "en", "de"] },
		},
	}),
	{ virtual: true },
);
vi.mock(
	"virtual:emdash/dialect",
	() => ({ createDialect: vi.fn(), createCoalescingDialect: undefined, createRequestScopedDb }),
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

vi.mock("../../../src/loader.js", () => ({ getDb }));

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

async function navigate(
	currentLocale?: string,
	next = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
) {
	await onRequest(htmlNavigation("/posts/hello", {}, { currentLocale }), next);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("layout prefetch on anonymous HTML navigations", () => {
	let realDb: Awaited<ReturnType<typeof setupTestDatabase>>;
	let rewriteQueryCount: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		realDb = await setupTestDatabase();
		Object.defineProperty(realDb.getExecutor().adapter, "supportsMultipleConnections", {
			value: true,
		});
		rewriteQueryCount = vi.spyOn(realDb.getExecutor(), "executeQuery");
	});

	afterAll(async () => {
		rewriteQueryCount.mockRestore();
		await teardownTestDatabase(realDb);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		getDb.mockResolvedValue({
			selectFrom: () => ({ selectAll: () => ({ limit: () => ({ execute: async () => [] }) }) }),
		});
		rewriteQueryCount.mockClear();
		prefetchLayoutData.mockImplementation(() =>
			requestCached("rewrite-layout", async () =>
				realDb.selectFrom("_emdash_migrations").selectAll().limit(1).execute(),
			).then(() => undefined),
		);
	});

	afterEach(() => {
		setI18nConfig(null);
		resetTaxonomyDefsCacheForTests();
	});

	const adapterWithoutFlag: DialectAdapter = {
		acquireMigrationLock: async () => undefined,
		releaseMigrationLock: async () => undefined,
	};

	async function renderImplicitLayout({
		targetLocale,
		pageLocale = "en",
		i18n = { defaultLocale: "cs", locales: ["cs", "en"] },
	}: {
		targetLocale?: string;
		pageLocale?: string;
		i18n?: I18nConfig | null;
	}) {
		// Initialize the middleware's once-per-isolate config before overriding it.
		createRequestScopedDb.mockReturnValue(null);
		await navigate();
		setI18nConfig(i18n);
		const db = await setupTestDatabaseWithCollections();
		onTestFinished(() => teardownTestDatabase(db));
		const menuRepository = new MenuRepository(db);
		const taxonomyRepository = new TaxonomyRepository(db);
		await menuRepository.create({ name: "primary", label: "Hlavní", locale: "cs" });
		await taxonomyRepository.create({
			name: "category",
			slug: "cs-term",
			label: "Česky",
			locale: "cs",
		});

		let queryCount = 0;
		const runtimeDb = db.withPlugin({
			transformQuery({ node }) {
				queryCount++;
				return node;
			},
			async transformResult({ result }) {
				return result;
			},
		});
		Object.defineProperty(runtimeDb.getExecutor().adapter, "supportsMultipleConnections", {
			value: true,
		});
		getDb.mockResolvedValue(runtimeDb);
		createRequestScopedDb.mockReturnValue({ db: runtimeDb, commit: vi.fn() });

		const actual = await vi.importActual<typeof import("../../../src/astro/prefetch.js")>(
			"../../../src/astro/prefetch.js",
		);
		let prefetch: Promise<void> | undefined;
		prefetchLayoutData.mockImplementationOnce(() => {
			prefetch = actual.prefetchLayoutData(targetLocale);
			return prefetch;
		});

		let queriesAfterPrefetch = 0;
		await navigate(pageLocale, async () => {
			await Promise.resolve();
			expect(prefetch).toBeDefined();
			await prefetch;
			queriesAfterPrefetch = queryCount;
			expect((await getMenu("primary"))?.label).toBe("Hlavní");
			expect(
				(await getTaxonomyTerms("category", { includeCounts: false })).map((term) => term.label),
			).toEqual(["Česky"]);
			return new Response("<html></html>", { headers: { "content-type": "text/html" } });
		});
		return { queryCount, queriesAfterPrefetch };
	}

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

	it.each(["en", "cs", undefined])("warms layout helpers for page locale %s", async (locale) => {
		setI18nConfig({ defaultLocale: "cs", locales: ["cs", "en", "de"] });
		const db = await setupTestDatabaseWithCollections();
		onTestFinished(() => teardownTestDatabase(db));
		const menuRepository = new MenuRepository(db);
		const taxonomyRepository = new TaxonomyRepository(db);
		const csMenu = await menuRepository.create({ name: "primary", label: "Hlavní", locale: "cs" });
		await menuRepository.create({
			name: "primary",
			label: "Main",
			locale: "en",
			translationOf: csMenu.id,
		});
		await taxonomyRepository.create({
			name: "category",
			slug: "cs-term",
			label: "Česky",
			locale: "cs",
		});
		await taxonomyRepository.create({
			name: "category",
			slug: "en-term",
			label: "English",
			locale: "en",
		});

		let queryCount = 0;
		const runtimeDb = db.withPlugin({
			transformQuery({ node }) {
				queryCount++;
				return node;
			},
			async transformResult({ result }) {
				return result;
			},
		});

		// Exercise the remote-backend prefetch path with the real SQLite driver.
		Object.defineProperty(runtimeDb.getExecutor().adapter, "supportsMultipleConnections", {
			value: true,
		});
		getDb.mockResolvedValue(runtimeDb);
		createRequestScopedDb.mockReturnValue({
			db: runtimeDb,
			commit: vi.fn(),
		});

		const actual = await vi.importActual<typeof import("../../../src/astro/prefetch.js")>(
			"../../../src/astro/prefetch.js",
		);
		let prefetch: Promise<void> | undefined;
		prefetchLayoutData.mockImplementationOnce((pageLocale) => {
			prefetch = actual.prefetchLayoutData(pageLocale);
			return prefetch;
		});

		await navigate(locale, async () => {
			await Promise.resolve();
			expect(prefetch).toBeDefined();
			await prefetch;
			const queriesAfterPrefetch = queryCount;
			const pageLocale = locale ?? "cs";
			const menu = await getMenu("primary", { locale: pageLocale });
			const terms = await getTaxonomyTerms("category", {
				locale: pageLocale,
				includeCounts: false,
			});
			expect(menu?.label).toBe(pageLocale === "en" ? "Main" : "Hlavní");
			expect(terms.map((term) => term.label)).toEqual([pageLocale === "en" ? "English" : "Česky"]);
			expect(queryCount).toBe(queriesAfterPrefetch);
			return new Response("<html></html>", { headers: { "content-type": "text/html" } });
		});

		expect(prefetchLayoutData).toHaveBeenCalledOnce();
	});

	it("does not query implicit helpers twice on a single-locale site", async () => {
		const counts = await renderImplicitLayout({
			targetLocale: "cs",
			pageLocale: "cs",
			i18n: { defaultLocale: "cs", locales: ["cs"] },
		});
		expect(counts.queryCount).toBeGreaterThan(0);
		expect(counts.queryCount).toBe(counts.queriesAfterPrefetch);
	});

	it("uses the unconfigured i18n locale for implicit helpers", async () => {
		const counts = await renderImplicitLayout({ targetLocale: "cs", pageLocale: "cs", i18n: null });
		expect(counts.queryCount).toBeGreaterThan(0);
		expect(counts.queryCount).toBe(counts.queriesAfterPrefetch);
	});

	it("measures the explicit-locale prefetch tradeoff for implicit consumers", async () => {
		const legacy = await renderImplicitLayout({ targetLocale: undefined });
		const current = await renderImplicitLayout({ targetLocale: "en" });
		expect(legacy.queryCount).toBe(legacy.queriesAfterPrefetch);
		expect(current.queryCount).toBeLessThanOrEqual(current.queriesAfterPrefetch + 2);
		expect(current.queryCount).toBeLessThanOrEqual(legacy.queryCount + 2);
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

	it.each([true, false])(
		"does not repeat layout reads through Astro's real rewrite pipeline (scoped db: %s)",
		async (hasScopedDb) => {
			const scope = { db: realDb, commit: vi.fn(), close: vi.fn() };
			createRequestScopedDb.mockReturnValue(hasScopedDb ? scope : null);
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
			const directQueries = rewriteQueryCount.mock.calls.length;
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
			expect(rewriteQueryCount).toHaveBeenCalledTimes(directQueries);
			expect(prefetchLayoutData).toHaveBeenCalledTimes(hasScopedDb ? 1 : 0);
			expect(createRequestScopedDb).toHaveBeenCalledOnce();
			expect(scope.commit).toHaveBeenCalledTimes(hasScopedDb ? 1 : 0);
			expect(scope.close).toHaveBeenCalledTimes(hasScopedDb ? 1 : 0);
		},
	);

	it("renders the target locale after rewriting across locale prefixes without a scoped database", async () => {
		createRequestScopedDb.mockReturnValue(null);
		const target = createComponent((result, props, slots) => {
			const Astro = result.createAstro(createAstro(), props, slots);
			return render`<p>${Astro.currentLocale}</p>`;
		});
		const source = createComponent((result, props, slots) => {
			const Astro = result.createAstro(createAstro(), props, slots);
			return Astro.rewrite("/de/target");
		});
		const container = await AstroContainer.create({
			manifest: {
				i18n: {
					strategy: "pathname-prefix-other-locales",
					defaultLocale: "cs",
					locales: ["cs", "en", "de"],
					domainLookupTable: {},
				},
				middleware: async () => ({ onRequest }),
			} as NonNullable<Parameters<typeof AstroContainer.create>[0]>["manifest"],
		});
		container.insertPageRoute("/de/target", target);
		const response = await container.renderToResponse(source, {
			request: new Request("https://example.com/en/missing", {
				headers: { accept: "text/html" },
			}),
		});
		expect(await response.text()).toContain("<p>de</p>");
		expect(createRequestScopedDb).toHaveBeenCalledOnce();
		expect(prefetchLayoutData).not.toHaveBeenCalled();
	});

	it("reuses the prefetched layout read for an anonymous rewrite", async () => {
		const scope = await rewrite();

		expect(rewriteQueryCount).toHaveBeenCalledOnce();
		expect(prefetchLayoutData).toHaveBeenCalledOnce();
		expect(createRequestScopedDb).toHaveBeenCalledOnce();
		expect(scope.commit).toHaveBeenCalledOnce();
		expect(scope.close).toHaveBeenCalledOnce();
	});

	it("does not reuse the cache across independent requests", async () => {
		await rewrite();
		await rewrite();

		expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
		expect(prefetchLayoutData).toHaveBeenCalledTimes(2);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
	});

	it("does not reuse the cache when the rewrite has different locals", async () => {
		await rewrite({ targetLocals: {} });

		expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
	});

	it.each(["/_emdash/api/content", "/sitemap.xml", "/robots.txt", "/sitemap-post.xml"])(
		"initializes runtime handlers for a rewrite to %s",
		async (targetPath) => {
			await rewrite({ targetPath });
			expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
			expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["astro-session", "emdash-edit-mode"])(
		"does not reuse the anonymous scope after a rewrite adds %s",
		async (cookieName) => {
			await rewrite({
				targetProperties: {
					cookies: {
						get: (name: string) => (name === cookieName ? { value: "true" } : undefined),
						set: vi.fn(),
					},
				},
			});
			expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
			expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
		},
	);

	it("keeps an unresolved session cookie on the initial anonymous fast path", async () => {
		createRequestScopedDb.mockReturnValue({ db: realDb, commit: vi.fn() });
		const context = htmlNavigation(
			"/404",
			{},
			{
				cookies: {
					get: (name: string) => (name === "astro-session" ? { value: "stale" } : undefined),
					set: vi.fn(),
				},
			},
		);
		const response = await onRequest(context, async () => new Response("page"));
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(context.session?.get).toHaveBeenCalledOnce();
		expect(prefetchLayoutData).toHaveBeenCalledOnce();
		expect(createRequestScopedDb).toHaveBeenCalledOnce();
	});

	it("initializes runtime handlers for a rewrite to a base-prefixed runtime route", async () => {
		vi.stubEnv("BASE_URL", "/cms/");
		onTestFinished(() => vi.unstubAllEnvs());
		await rewrite({ targetPath: "/cms/robots.txt" });
		expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(2);
	});

	it("does not reuse the cache for a preview target", async () => {
		await rewrite({ targetPath: "/404?_preview=1" });

		expect(rewriteQueryCount).toHaveBeenCalledTimes(2);
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
