import { AsyncLocalStorage } from "node:async_hooks";

import {
	type CompiledQuery,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME, adapter, createRuntime } = vi.hoisted(() => ({
	MOCK_RUNTIME: {
		storage: null,
		db: {},
		hooks: {},
		email: null,
		configuredPlugins: [],
		getPluginRouteMeta: () => null,
		handlePluginApiRoute: async () => ({ success: true }),
		collectPageMetadata: async () => [],
		collectPageFragments: async () => [],
	},
	adapter: {
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn(),
	},
	createRuntime: vi.fn(),
}));

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: { database: { entrypoint: "test-adapter", config: {} }, auth: { mode: "none" } },
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/dialect", () => adapter, { virtual: true });
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
		create: createRuntime,
		isDatabaseUnmigrated: () => false,
		getStorage: () => null,
	},
}));

vi.mock("../../../src/astro/prefetch.js", () => ({ prefetchLayoutData: async () => undefined }));

import onRequest from "../../../src/astro/middleware.js";
import { getDb } from "../../../src/loader.js";

/** Which simulated request is running, like workerd's per-request I/O context. */
const currentRequest = new AsyncLocalStorage<number>();

interface Query {
	request: number | undefined;
	sql: string;
}

/** A driver that records every query it runs and the request that ran it. */
class RecordingDriver implements Driver {
	constructor(readonly queries: Query[]) {}
	async init() {}
	async acquireConnection(): Promise<DatabaseConnection> {
		return {
			executeQuery: async (query: CompiledQuery) => {
				this.queries.push({ request: currentRequest.getStore(), sql: query.sql });
				return { rows: [] };
			},
			streamQuery: () => {
				throw new Error("not supported");
			},
		};
	}
	async beginTransaction() {}
	async commitTransaction() {}
	async rollbackTransaction() {}
	async releaseConnection() {}
	async destroy() {}
}

function recordingDialect(queries: Query[]): Dialect {
	return {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new RecordingDriver(queries),
		createIntrospector: (db) => new PostgresIntrospector(db),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	};
}

function anonymousPageContext() {
	return {
		request: new Request("https://example.com/posts/hello", {
			headers: { accept: "text/html" },
		}),
		url: new URL("https://example.com/posts/hello"),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
	} as unknown as Parameters<typeof onRequest>[0];
}

/** A page render that reads through the same db getter template helpers use. */
async function renderPage() {
	const db = await getDb();
	await db.selectFrom("options").selectAll().execute();
	return new Response("<html></html>", { headers: { "content-type": "text/html" } });
}

describe("concurrent first requests on a request-scoped adapter", () => {
	let singletonQueries: Query[];
	let scopedQueries: Query[][];

	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:runtime-holder")];
		singletonQueries = [];
		scopedQueries = [];
		adapter.createDialect.mockReset().mockImplementation(() => recordingDialect(singletonQueries));
		adapter.createRequestScopedDb.mockReset().mockImplementation(() => {
			const queries: Query[] = [];
			scopedQueries.push(queries);
			return {
				db: new Kysely({ dialect: recordingDialect(queries) }),
				commit: () => {},
				close: () => {},
			};
		});
		let releaseInit = () => {};
		const initHeld = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		createRuntime.mockReset().mockImplementation(async () => {
			await initHeld;
			return MOCK_RUNTIME;
		});
		setTimeout(releaseInit, 20);
	});

	it("never query the per-isolate connection", async () => {
		const responses = await Promise.all(
			[1, 2].map(async (request) =>
				currentRequest.run(request, () => onRequest(anonymousPageContext(), renderPage)),
			),
		);

		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(singletonQueries).toEqual([]);
		expect(adapter.createDialect).not.toHaveBeenCalled();
		expect(scopedQueries).toHaveLength(2);
		for (const queries of scopedQueries) {
			expect(queries).toHaveLength(1);
			expect(queries[0]!.sql).toContain('"options"');
		}
		expect(
			scopedQueries.map((queries) => queries[0]!.request ?? 0).toSorted((a, b) => a - b),
		).toEqual([1, 2]);
	});
});
