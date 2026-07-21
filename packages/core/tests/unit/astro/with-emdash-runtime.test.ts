/**
 * Tests for withEmDashRuntime() (#1887): the request-free runtime accessor
 * for queue consumers and scheduled() handlers.
 *
 * Covers the stateless-adapter fast path, the connection-backed adapter path
 * (event-scoped db in ALS + guaranteed commit/close), and error propagation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME } = vi.hoisted(() => ({
	MOCK_RUNTIME: {
		_marker: "runtime",
		handlePluginApiRoute: vi.fn(async () => ({ success: true, data: { done: true } })),
		runScheduledTasks: vi.fn(async () => ({ published: [] })),
	},
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

import { createRequestScopedDb } from "virtual:emdash/dialect";

import { withEmDashRuntime } from "../../../src/astro/middleware.js";
import { getRequestContext } from "../../../src/request-context.js";

const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");

describe("withEmDashRuntime (#1887)", () => {
	beforeEach(() => {
		// Reset the globalThis runtime singleton so each test builds fresh
		delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
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

	it("uses the singleton path for a close-less scope", async () => {
		const commit = vi.fn();
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: { _marker: "scoped" } as never,
			commit,
		});

		await expect(withEmDashRuntime(() => "ok")).resolves.toBe("ok");
		// Close-less scope is discarded — nothing to commit outside a request
		expect(commit).not.toHaveBeenCalled();
	});
});
