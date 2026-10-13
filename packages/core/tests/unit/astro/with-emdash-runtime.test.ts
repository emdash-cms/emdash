/**
 * Tests for withEmDashRuntime() (#1887): the request-free runtime accessor
 * for queue consumers and scheduled() handlers.
 *
 * Covers the stateless-adapter fast path, the connection-backed adapter path
 * (event-scoped db in ALS + guaranteed commit/close), and error propagation.
 */

import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME, mockGetLastContentWriteAt } = vi.hoisted(() => ({
	MOCK_RUNTIME: {
		_marker: "runtime",
		handlePluginApiRoute: vi.fn(async () => ({ success: true, data: { done: true } })),
		runScheduledTasks: vi.fn(async () => ({ published: [] })),
	},
	mockGetLastContentWriteAt: vi.fn(async () => 123_456),
}));

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: { config: { binding: "DB" } },
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
		createCoalescingDialect: undefined,
	}),
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
	EmDashRuntime: {
		create: async () => MOCK_RUNTIME,
	},
}));

vi.mock("../../../src/object-cache/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/object-cache/index.js")>()),
	getLastContentWriteAt: mockGetLastContentWriteAt,
}));

import { createRequestScopedDb } from "virtual:emdash/dialect";

import { after } from "../../../src/after.js";
import { withEmDashRuntime } from "../../../src/astro/middleware.js";
import {
	PREVIEW_SECRET_OPTION_KEY,
	_clearSecretsCacheForTesting,
	resolveSecretsCached,
} from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { getRequestContext, runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");

const SECRET_ENV_VARS = [
	"EMDASH_PREVIEW_SECRET",
	"PREVIEW_SECRET",
	"EMDASH_IP_SALT",
	"EMDASH_AUTH_SECRET",
	"AUTH_SECRET",
];

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count += 1;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

function scopedDbFromContext(): Kysely<Database> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the event scope stores the adapter's handle
	return getRequestContext()?.db as Kysely<Database>;
}

describe("withEmDashRuntime (#1887)", () => {
	beforeEach(() => {
		// Reset the globalThis runtime singleton so each test builds fresh
		delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		mockGetLastContentWriteAt.mockClear();
	});

	it("does not read the content-write marker for write workloads", async () => {
		await withEmDashRuntime(() => "ok");

		expect(mockGetLastContentWriteAt).not.toHaveBeenCalled();
		expect(createRequestScopedDb).toHaveBeenCalledWith(
			expect.objectContaining({ canUseCachedBinding: false }),
		);
	});

	it("passes the runtime to the callback and returns its result (stateless adapter)", async () => {
		const result = await withEmDashRuntime(async (runtime) => {
			expect(runtime).toBe(MOCK_RUNTIME);
			return "job-done";
		});
		expect(result).toBe("job-done");
	});

	it("supports a synchronous callback", async () => {
		await expect(withEmDashRuntime(() => 42)).resolves.toBe(42);
	});

	it("runs the callback under the event-scoped db and commits/closes it", async () => {
		const commit = vi.fn();
		const close = vi.fn();
		const scopedDb = { _marker: "scoped" };
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: scopedDb as never,
			commit,
			close,
		});

		let dbSeenByCallback: unknown;
		const result = await withEmDashRuntime(async () => {
			dbSeenByCallback = getRequestContext()?.db;
			return "ok";
		});

		expect(result).toBe("ok");
		expect(dbSeenByCallback).toBe(scopedDb);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		// The event context must not leak past the call
		expect(getRequestContext()).toBeUndefined();

		// The scope must be flagged as a write workload so connection-backed
		// adapters route queue jobs to the primary.
		const opts = vi.mocked(createRequestScopedDb).mock.calls[0]?.[0];
		expect(opts).toMatchObject({ isAuthenticated: false, isWrite: true });
	});

	it("still commits and closes the scoped db when the callback throws", async () => {
		const commit = vi.fn();
		const close = vi.fn();
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: { _marker: "scoped" } as never,
			commit,
			close,
		});

		await expect(
			withEmDashRuntime(async () => {
				throw new Error("job failed");
			}),
		).rejects.toThrow("job failed");

		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("does not finish an event before deferred work releases its scoped db", async () => {
		let release!: () => void;
		let returned = false;
		const close = vi.fn();
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: { _marker: "scoped" } as never,
			commit: vi.fn(),
			close,
		});

		const resultPromise = withEmDashRuntime(async () => {
			after(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			return "ok";
		}).then((result) => {
			returned = true;
			return result;
		});

		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await Promise.resolve();
		expect(returned).toBe(false);
		expect(close).not.toHaveBeenCalled();

		release();
		await expect(resultPromise).resolves.toBe("ok");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("runs outside-request work under a close-less scoped db", async () => {
		const commit = vi.fn();
		const scopedDb = { _marker: "scoped" };
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: scopedDb as never,
			commit,
		});

		let dbSeenByCallback: unknown;
		await expect(
			withEmDashRuntime(() => {
				dbSeenByCallback = getRequestContext()?.db;
				return "ok";
			}),
		).resolves.toBe("ok");
		expect(dbSeenByCallback).toBe(scopedDb);
		expect(commit).toHaveBeenCalledOnce();
	});
});

// Requests get their handle from the same `createRequestScopedDb` wrapper as events.
describe("resolveSecretsCached with request-scoped databases", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
		for (const name of SECRET_ENV_VARS) vi.stubEnv(name, "");
		_clearSecretsCacheForTesting();
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.mocked(createRequestScopedDb).mockReset();
		_clearSecretsCacheForTesting();
		await teardownTestDatabase(db);
	});

	it("reads the stored secrets once across handles for different events", async () => {
		const firstEvent = new QueryCountingPlugin();
		const secondEvent = new QueryCountingPlugin();
		vi.mocked(createRequestScopedDb)
			.mockReturnValueOnce({ db: db.withPlugin(firstEvent), commit: vi.fn() })
			.mockReturnValueOnce({ db: db.withPlugin(secondEvent), commit: vi.fn() });

		const first = await withEmDashRuntime(() => resolveSecretsCached(scopedDbFromContext()));
		const second = await withEmDashRuntime(() => resolveSecretsCached(scopedDbFromContext()));

		expect(firstEvent.count).toBeGreaterThan(0);
		expect(secondEvent.count).toBe(0);
		expect(second).toEqual(first);
	});

	it("resolves a database that other code puts in the request context on its own", async () => {
		vi.mocked(createRequestScopedDb).mockReturnValue({ db: db.withoutPlugins(), commit: vi.fn() });
		const configured = await withEmDashRuntime(() => resolveSecretsCached(scopedDbFromContext()));

		const otherDb = await setupTestDatabase();
		try {
			const other = await runWithContext({ editMode: false, db: otherDb }, () =>
				resolveSecretsCached(otherDb),
			);
			expect(other.previewSecret).not.toBe(configured.previewSecret);
			expect(other.previewSecret).toBe(
				await new OptionsRepository(otherDb).get<string>(PREVIEW_SECRET_OPTION_KEY),
			);
		} finally {
			await teardownTestDatabase(otherDb);
		}
	});
});
