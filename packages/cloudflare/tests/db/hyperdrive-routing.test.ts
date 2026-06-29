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

const cookies = {
	get: () => undefined,
	set: () => {},
};
const url = new URL("https://example.com/");

describe("selectBindingName", () => {
	it("uses the cached binding for anonymous reads when configured", () => {
		const name = selectBindingName(
			{ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			{ isAuthenticated: false, isWrite: false },
		);
		expect(name).toBe("HYPERDRIVE_CACHED");
	});

	it("uses the primary binding for authenticated reads", () => {
		const name = selectBindingName(
			{ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			{ isAuthenticated: true, isWrite: false },
		);
		expect(name).toBe("HYPERDRIVE");
	});

	it("uses the primary binding for anonymous writes", () => {
		const name = selectBindingName(
			{ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" },
			{ isAuthenticated: false, isWrite: true },
		);
		expect(name).toBe("HYPERDRIVE");
	});

	it("always uses the primary binding when no cachedBinding is set", () => {
		expect(
			selectBindingName({ binding: "HYPERDRIVE" }, { isAuthenticated: false, isWrite: false }),
		).toBe("HYPERDRIVE");
		expect(
			selectBindingName({ binding: "HYPERDRIVE" }, { isAuthenticated: true, isWrite: true }),
		).toBe("HYPERDRIVE");
	});
});

describe("createRequestScopedDb binding routing", () => {
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
