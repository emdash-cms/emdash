import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { MOCK_RUNTIME, mockCreateRuntime, getDb, probeExecute } = vi.hoisted(() => {
	const execute = vi.fn(async () => []);
	return {
		mockCreateRuntime: vi.fn(),
		probeExecute: execute,
		getDb: vi.fn(async () => ({
			selectFrom: () => ({ selectAll: () => ({ limit: () => ({ execute }) }) }),
		})),
		MOCK_RUNTIME: {
			storage: { getPublicUrl: (key: string) => `https://media.example.com/${key}` },
			db: {},
			rooms: null,
			hooks: {},
			configuredPlugins: [],
			getPluginRouteMeta: () => null,
			handlePluginApiRoute: async () => ({ success: true }),
			collectPageMetadata: async () => [],
			collectPageFragments: async () => [],
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
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn(() => null),
		// Present: the runtime folds its migration-count read into the init batch.
		createCoalescingDialect: vi.fn(),
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
	EmDashRuntime: { create: mockCreateRuntime },
}));

vi.mock("../../../src/loader.js", () => ({ getDb }));

import onRequest from "../../../src/astro/middleware.js";

type FoldSink = (count: Promise<number | null | undefined> | undefined) => void;

function foldingInit(count: number | null | undefined, outcome: "resolve" | "reject" = "resolve") {
	mockCreateRuntime.mockImplementation(
		async (_deps: unknown, _timings: unknown, onFold?: FoldSink) => {
			onFold?.(Promise.resolve(count));
			if (outcome === "reject") throw new Error("migration 001 failed");
			return MOCK_RUNTIME;
		},
	);
}

function anonymousPage() {
	return {
		request: new Request("https://example.com/category/news"),
		url: new URL("https://example.com/category/news"),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
	} as unknown as Parameters<typeof onRequest>[0];
}

describe("setup probe folded into runtime init", () => {
	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:setup-verified")];
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:runtime-holder")];
		mockCreateRuntime.mockReset();
		probeExecute.mockClear();
		getDb.mockClear();
	});

	it("skips the probe query when the init batch read the migration count", async () => {
		foldingInit(42);
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(anonymousPage(), next);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledTimes(1);
		expect(probeExecute).not.toHaveBeenCalled();
	});

	it("treats a missing migrations table in the batch as un-migrated", async () => {
		foldingInit(null, "reject");
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(anonymousPage(), next);

		expect(probeExecute).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
	});

	it("falls back to the probe when the folded read failed", async () => {
		foldingInit(undefined);
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(anonymousPage(), next);

		expect(response.status).toBe(200);
		expect(probeExecute).toHaveBeenCalledTimes(1);
	});

	it("falls back to the probe when init does not fold", async () => {
		mockCreateRuntime.mockResolvedValue(MOCK_RUNTIME);
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(anonymousPage(), next);

		expect(response.status).toBe(200);
		expect(probeExecute).toHaveBeenCalledTimes(1);
	});

	it("probes without waiting when another request owns the init", async () => {
		let releaseFirst = () => {};
		mockCreateRuntime.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseFirst = () => resolve(MOCK_RUNTIME);
				}),
		);
		const first = onRequest(anonymousPage(), async () => new Response("first"));
		await vi.waitFor(() => expect(mockCreateRuntime).toHaveBeenCalledTimes(1));

		const second = onRequest(anonymousPage(), async () => new Response("second"));
		await vi.waitFor(() => expect(probeExecute).toHaveBeenCalled());

		releaseFirst();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
	});
});
