import { describe, expect, it, vi } from "vitest";

// The hyperdrive runtime adapter imports the bindings from cloudflare:workers,
// builds a node-postgres Pool, and routes per-request queries through the
// instrumentation logger. Mock all three so we can assert which binding's
// connection string the per-request pool is built from, without a real DB.
const { poolCalls, fakeEnv } = vi.hoisted(() => ({
	poolCalls: [] as Array<{ connectionString: string }>,
	fakeEnv: {
		HYPERDRIVE: { connectionString: "postgres://primary/uncached" },
		HYPERDRIVE_CACHED: { connectionString: "postgres://replica/cached" },
	} as Record<string, { connectionString: string }>,
}));

vi.mock("cloudflare:workers", () => ({
	env: fakeEnv,
	waitUntil: (_p: Promise<unknown>) => {},
}));

vi.mock("pg", () => ({
	Pool: class {
		constructor(opts: { connectionString: string }) {
			poolCalls.push({ connectionString: opts.connectionString });
		}
		// Kysely's PostgresDialect only needs these to construct; no query runs.
		async end() {}
	},
}));

vi.mock("emdash/database/instrumentation", () => ({
	kyselyLogOption: () => undefined,
}));

import { createRequestScopedDb, selectBindingName } from "../../src/db/hyperdrive.js";
import { hyperdrive } from "../../src/index.js";

const cookies = {
	get: () => undefined,
	set: () => {},
};
const url = new URL("https://example.com/");

const publicUrl = new URL("https://example.com/posts");
const cfg = { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" };
const now = 10_000_000;

describe("selectBindingName", () => {
	it("uses the cached binding for anonymous reads of public paths", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: false,
			url: publicUrl,
			now,
		});
		expect(name).toBe("HYPERDRIVE_CACHED");
	});

	it("uses the primary binding for authenticated reads", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: true,
			isWrite: false,
			url: publicUrl,
			now,
		});
		expect(name).toBe("HYPERDRIVE");
	});

	it("uses the primary binding for anonymous writes", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: true,
			url: publicUrl,
			now,
		});
		expect(name).toBe("HYPERDRIVE");
	});

	it("uses the primary binding when middleware excludes a read from public caching", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: false,
			canUseCachedBinding: false,
			url: publicUrl,
			now,
		});
		expect(name).toBe("HYPERDRIVE");
	});

	it("uses the primary binding for anonymous GETs under /_emdash (setup/auth/admin APIs)", () => {
		for (const path of [
			"/_emdash",
			"/_emdash/admin",
			"/_emdash/admin/setup",
			"/_emdash/api/setup/status",
			"/_emdash/api/auth/me",
		]) {
			const name = selectBindingName(cfg, {
				isAuthenticated: false,
				isWrite: false,
				url: new URL(`https://example.com${path}`),
				now,
			});
			expect(name, `path ${path} must use the primary binding`).toBe("HYPERDRIVE");
		}
	});

	it("does not treat a public path that merely contains _emdash as internal", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: false,
			url: new URL("https://example.com/posts/about-_emdash"),
			now,
		});
		expect(name).toBe("HYPERDRIVE_CACHED");
	});

	it("always uses the primary binding when no cachedBinding is set", () => {
		expect(
			selectBindingName(
				{ binding: "HYPERDRIVE" },
				{ isAuthenticated: false, isWrite: false, url: publicUrl, now },
			),
		).toBe("HYPERDRIVE");
		expect(
			selectBindingName(
				{ binding: "HYPERDRIVE" },
				{ isAuthenticated: true, isWrite: true, url: publicUrl, now },
			),
		).toBe("HYPERDRIVE");
	});

	it("uses the primary binding for anonymous public reads soon after a content write", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: false,
			url: publicUrl,
			lastContentWriteAt: now - 1_000,
			now,
		});
		expect(name).toBe("HYPERDRIVE");
	});

	it("uses the current time when callers omit now", () => {
		const currentTime = 10_000_000;
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(currentTime);
		try {
			const name = selectBindingName(cfg, {
				isAuthenticated: false,
				isWrite: false,
				url: publicUrl,
				lastContentWriteAt: currentTime - 1_000,
			});
			expect(name).toBe("HYPERDRIVE");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("uses the cached binding once the prefer-uncached window has elapsed", () => {
		const name = selectBindingName(cfg, {
			isAuthenticated: false,
			isWrite: false,
			url: publicUrl,
			lastContentWriteAt: now - 61_000,
			now,
		});
		expect(name).toBe("HYPERDRIVE_CACHED");
	});

	it("uses the cached binding when lastContentWriteAt is zero or missing", () => {
		expect(
			selectBindingName(cfg, {
				isAuthenticated: false,
				isWrite: false,
				url: publicUrl,
				lastContentWriteAt: 0,
				now,
			}),
		).toBe("HYPERDRIVE_CACHED");
		expect(
			selectBindingName(cfg, {
				isAuthenticated: false,
				isWrite: false,
				url: publicUrl,
				now,
			}),
		).toBe("HYPERDRIVE_CACHED");
	});

	it("respects a custom preferUncachedAfterWriteMs", () => {
		const custom = {
			binding: "HYPERDRIVE",
			cachedBinding: "HYPERDRIVE_CACHED",
			preferUncachedAfterWriteMs: 5_000,
		};
		expect(
			selectBindingName(custom, {
				isAuthenticated: false,
				isWrite: false,
				url: publicUrl,
				lastContentWriteAt: now - 2_000,
				now,
			}),
		).toBe("HYPERDRIVE");
		expect(
			selectBindingName(custom, {
				isAuthenticated: false,
				isWrite: false,
				url: publicUrl,
				lastContentWriteAt: now - 6_000,
				now,
			}),
		).toBe("HYPERDRIVE_CACHED");
	});

	it("ignores lastContentWriteAt when no cachedBinding is set", () => {
		expect(
			selectBindingName(
				{ binding: "HYPERDRIVE" },
				{
					isAuthenticated: false,
					isWrite: false,
					url: publicUrl,
					lastContentWriteAt: now,
					now,
				},
			),
		).toBe("HYPERDRIVE");
	});
});

describe("createRequestScopedDb binding routing", () => {
	it("routes builder configuration through the primary binding inside a custom window", () => {
		poolCalls.length = 0;
		const descriptor = hyperdrive({
			binding: "HYPERDRIVE",
			cachedBinding: "HYPERDRIVE_CACHED",
			preferUncachedAfterWriteMs: 5_000,
		});

		createRequestScopedDb({
			config: descriptor.config as Parameters<typeof createRequestScopedDb>[0]["config"],
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url,
			lastContentWriteAt: 8_000,
			now: 10_000,
		});

		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("builds the pool from the cached binding for anonymous reads", () => {
		poolCalls.length = 0;
		const scoped = createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url,
		});
		expect(scoped).not.toBeNull();
		expect(poolCalls).toHaveLength(1);
		expect(poolCalls[0]!.connectionString).toBe("postgres://replica/cached");
	});

	it("builds the pool from the primary binding when lastContentWriteAt is recent", () => {
		poolCalls.length = 0;
		createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url,
			lastContentWriteAt: Date.now() - 500,
		});
		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("builds the pool from the primary binding for authenticated reads", () => {
		poolCalls.length = 0;
		createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			isAuthenticated: true,
			isWrite: false,
			cookies,
			url,
		});
		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("builds the pool from the primary binding for writes", () => {
		poolCalls.length = 0;
		createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			isAuthenticated: false,
			isWrite: true,
			cookies,
			url,
		});
		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("builds the pool from the primary binding for anonymous /_emdash reads", () => {
		poolCalls.length = 0;
		createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/_emdash/api/setup/status"),
		});
		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("falls back to the primary binding when the cached binding is missing at runtime", () => {
		poolCalls.length = 0;
		const scoped = createRequestScopedDb({
			config: { binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_MISSING" },
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url,
		});
		expect(scoped).not.toBeNull();
		expect(poolCalls[0]!.connectionString).toBe("postgres://primary/uncached");
	});

	it("returns null when the primary binding is absent (singleton fallback)", () => {
		poolCalls.length = 0;
		const scoped = createRequestScopedDb({
			config: { binding: "NOPE" },
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url,
		});
		expect(scoped).toBeNull();
		expect(poolCalls).toHaveLength(0);
	});
});
