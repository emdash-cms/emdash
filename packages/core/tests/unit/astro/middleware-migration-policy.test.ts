import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { VIRTUAL_CONFIG, mockRuntimeCreate, mockGetDb } = vi.hoisted(() => ({
	VIRTUAL_CONFIG: {
		database: { entrypoint: "test", config: {}, type: "sqlite" },
		migrations: { runtime: "check", dev: "check" },
	},
	mockRuntimeCreate: vi.fn(),
	mockGetDb: vi.fn(),
}));

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: VIRTUAL_CONFIG,
	}),
	{ virtual: true },
);
vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createCoalescingDialect: undefined,
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
	EmDashRuntime: { create: mockRuntimeCreate },
}));
vi.mock("../../../src/loader.js", () => ({ getDb: mockGetDb }));

import onRequest from "../../../src/astro/middleware.js";
import { PendingMigrationsError } from "../../../src/database/migrations/policy.js";

const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");

function contextFor(pathname: string) {
	const url = new URL(pathname, "https://example.com");
	return {
		request: new Request(url),
		url,
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
	};
}

describe("middleware migration check failures", () => {
	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
		delete (globalThis as Record<symbol, unknown>)[SETUP_VERIFIED_KEY];
		mockGetDb.mockReset();
		VIRTUAL_CONFIG.migrations = { runtime: "check", dev: "check" };
		mockRuntimeCreate
			.mockReset()
			.mockRejectedValue(new PendingMigrationsError(["059_private_migration_name"]));
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it.each(["/", "/_emdash/api/content/posts"])(
		"returns a generic retryable 503 for %s",
		async (pathname) => {
			const next = vi.fn(async () => new Response("route response"));
			const response = await onRequest(contextFor(pathname) as never, next);

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("60");
			expect(await response.text()).toBe(
				"Database migrations are required. Apply the deployment migration manifest and retry.",
			);
			expect(next).not.toHaveBeenCalled();
			expect(mockGetDb).not.toHaveBeenCalled();
			expect(JSON.stringify([...response.headers])).not.toContain("059_private_migration_name");
		},
	);

	it.each(["/", "/_emdash/api/setup"])(
		"instructs operators when manual mode reaches an unmigrated schema at %s",
		async (pathname) => {
			VIRTUAL_CONFIG.migrations = { runtime: "manual", dev: "manual" };
			mockRuntimeCreate.mockRejectedValue(new Error("no such table: options"));
			const next = vi.fn(async () => new Response("route response"));

			const response = await onRequest(contextFor(pathname) as never, next);

			expect(response.status).toBe(503);
			expect(await response.text()).toContain("deployment migration manifest");
			expect(next).not.toHaveBeenCalled();
			expect(mockGetDb).not.toHaveBeenCalled();
		},
	);
});
