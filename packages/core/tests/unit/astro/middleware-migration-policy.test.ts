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
import {
	MigrationLockHeldError,
	MigrationRowLimitError,
} from "../../../src/database/migrations/runner.js";

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

	describe("in auto mode", () => {
		const lockHeld = new MigrationLockHeldError(1788264000000);
		const errors: Array<[string, Error]> = [
			["a migration lock left behind", lockHeld],
			[
				"a backed-off migration lock",
				new Error("Database initialization is backing off after a recent migration failure", {
					cause: lockHeld,
				}),
			],
			[
				"content migrations over the row limit",
				new MigrationRowLimitError(["079_datetime_normalization"], 5000),
			],
		];

		beforeEach(() => {
			VIRTUAL_CONFIG.migrations = { runtime: "auto", dev: "auto" };
			mockGetDb.mockResolvedValue({
				selectFrom: () => ({
					selectAll: () => ({ limit: () => ({ execute: async () => [] }) }),
				}),
			});
		});

		describe.each(errors)("with %s", (_label, error) => {
			it.each(["/", "/_emdash/api/content/posts"])(
				"returns a retryable 503 for %s",
				async (pathname) => {
					mockRuntimeCreate.mockRejectedValue(error);
					const next = vi.fn(async () => new Response("route response"));

					const response = await onRequest(contextFor(pathname) as never, next);

					expect(response.status).toBe(503);
					expect(response.headers.get("Retry-After")).toBe("60");
					expect(next).not.toHaveBeenCalled();
				},
			);
		});

		it("logs a migration it waits for at most once every 30 seconds", async () => {
			mockRuntimeCreate.mockRejectedValue(lockHeld);
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			errorLog.mockClear();
			const start = Date.now() + 60_000;
			const now = vi.spyOn(Date, "now").mockReturnValue(start);
			const requiredLogs = () =>
				errorLog.mock.calls.filter(
					([message]) => message === "[emdash] database migrations are required:",
				).length;
			const request = () => onRequest(contextFor("/") as never, vi.fn());

			try {
				await request();
				await request();
				expect(requiredLogs()).toBe(1);

				now.mockReturnValue(start + 30_000);
				await request();
				expect(requiredLogs()).toBe(2);
			} finally {
				now.mockRestore();
			}
		});

		it("still renders a public page when runtime init fails for another reason", async () => {
			mockRuntimeCreate.mockRejectedValue(new Error("connection reset"));
			const next = vi.fn(async () => new Response("route response"));

			const response = await onRequest(contextFor("/") as never, next);

			expect(response.status).toBe(200);
			expect(next).toHaveBeenCalled();
		});
	});
});
