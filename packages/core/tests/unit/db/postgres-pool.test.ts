import { describe, expect, it, vi } from "vitest";

const poolInstances: Array<{
	options: Record<string, unknown>;
	listeners: Map<string, Array<(...args: unknown[]) => void>>;
}> = [];

vi.mock("pg", () => ({
	Pool: class {
		options: Record<string, unknown>;
		listeners = new Map<string, Array<(...args: unknown[]) => void>>();

		constructor(options: Record<string, unknown>) {
			this.options = options;
			poolInstances.push(this);
		}

		on(event: string, listener: (...args: unknown[]) => void) {
			const existing = this.listeners.get(event) ?? [];
			existing.push(listener);
			this.listeners.set(event, existing);
			return this;
		}
	},
}));

vi.mock("../../../src/database/pg-migration-lock.js", () => ({
	FailFastPostgresDialect: class {
		constructor(public config: unknown) {}
	},
}));

const { createDialect } = await import("../../../src/db/postgres.js");

function makePool(config: Parameters<typeof createDialect>[0]) {
	poolInstances.length = 0;
	createDialect(config);
	const pool = poolInstances[0];
	if (!pool) throw new Error("createDialect did not construct a Pool");
	return pool;
}

describe("createDialect pool timeouts", () => {
	it("passes connect and idle timeouts through to pg", () => {
		const pool = makePool({
			connectionString: "postgres://localhost/db",
			pool: { connectionTimeoutMillis: 2_000, idleTimeoutMillis: 10_000 },
		});

		expect(pool.options.connectionTimeoutMillis).toBe(2_000);
		expect(pool.options.idleTimeoutMillis).toBe(10_000);
	});

	it("leaves both undefined when unset, so pg keeps its own defaults", () => {
		// Not zero and not an invented default: an unset option must stay
		// absent, or this change would silently alter behaviour for every
		// existing deployment.
		const pool = makePool({ connectionString: "postgres://localhost/db" });

		expect(pool.options.connectionTimeoutMillis).toBeUndefined();
		expect(pool.options.idleTimeoutMillis).toBeUndefined();
	});

	it("still applies the existing min and max defaults", () => {
		const pool = makePool({ connectionString: "postgres://localhost/db" });

		expect(pool.options.min).toBe(0);
		expect(pool.options.max).toBe(10);
	});
});

describe("createDialect idle-client error handling", () => {
	it("attaches an error listener to the pool", () => {
		const pool = makePool({ connectionString: "postgres://localhost/db" });

		expect(pool.listeners.get("error") ?? []).toHaveLength(1);
	});

	it("swallows an idle-client error instead of letting it reach the process", () => {
		// The reason this listener exists. `error` on an EventEmitter with no
		// listener makes Node throw, which ends a server process. A failover
		// raises exactly that event on an idle client, and pg recovers on its
		// own, so logging is the whole job.
		const pool = makePool({ connectionString: "postgres://localhost/db" });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const listener = pool.listeners.get("error")?.[0];

		expect(listener).toBeTypeOf("function");
		expect(() => listener?.(new Error("terminating connection due to failover"))).not.toThrow();
		expect(consoleError).toHaveBeenCalledOnce();

		consoleError.mockRestore();
	});
});
