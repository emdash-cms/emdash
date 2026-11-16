import {
	type DialectAdapter,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { afterEach, beforeEach, describe, it, expect, onTestFinished, vi } from "vitest";

import { MenuRepository } from "../../../src/database/repositories/menu.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { type I18nConfig, setI18nConfig } from "../../../src/i18n/config.js";
import { getMenu } from "../../../src/menus/index.js";
import { getTaxonomyTerms, resetTaxonomyDefsCacheForTests } from "../../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

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
	EmDashRuntime: { create: async () => MOCK_RUNTIME },
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

function htmlNavigation(currentLocale?: string) {
	return {
		request: new Request("https://example.com/posts/hello", {
			headers: { accept: "text/html,application/xhtml+xml" },
		}),
		url: new URL("https://example.com/posts/hello"),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		currentLocale,
		session: { get: vi.fn(async () => null) },
	} as unknown as Parameters<typeof onRequest>[0];
}

async function navigate(
	currentLocale?: string,
	next = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
) {
	await onRequest(htmlNavigation(currentLocale), next);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("layout prefetch on anonymous HTML navigations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getDb.mockResolvedValue({
			selectFrom: () => ({ selectAll: () => ({ limit: () => ({ execute: async () => [] }) }) }),
		});
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
});
