import { inspect } from "node:util";

import type { Driver } from "kysely";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PostgresConfig } from "../../../src/db/adapters.js";
import { createDialect } from "../../../src/db/postgres.js";

const drivers: Driver[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(drivers.splice(0).map((driver) => driver.destroy()));
});

async function capturePool(config: PostgresConfig): Promise<Pool> {
	const pools: Pool[] = [];
	const captured = new Error("pool captured");
	const connect = vi.spyOn(Pool.prototype, "connect").mockImplementation(function (this: Pool) {
		pools.push(this);
		return Promise.reject(captured);
	});
	const driver = createDialect(config).createDriver();
	drivers.push(driver);
	await driver.init();

	try {
		await expect(driver.acquireConnection()).rejects.toBe(captured);
	} finally {
		connect.mockRestore();
	}

	const pool = pools[0];
	if (!pool) throw new Error("createDialect did not create a pg.Pool");
	return pool;
}

describe("PostgreSQL pool configuration", () => {
	it("applies configured connection and idle timeouts to pg.Pool", async () => {
		const pool = await capturePool({
			connectionString: "postgres://localhost/emdash",
			pool: {
				connectionTimeoutMillis: 2_500,
				idleTimeoutMillis: 30_000,
			},
		});

		expect(pool.options.connectionTimeoutMillis).toBe(2_500);
		expect(pool.options.idleTimeoutMillis).toBe(30_000);
	});

	it("preserves pg.Pool timeout defaults when options are omitted", async () => {
		const defaults = new Pool();
		const pool = await capturePool({ connectionString: "postgres://localhost/emdash" });

		try {
			expect(pool.options.connectionTimeoutMillis).toBe(defaults.options.connectionTimeoutMillis);
			expect(pool.options.idleTimeoutMillis).toBe(defaults.options.idleTimeoutMillis);
		} finally {
			await defaults.end();
		}
	});
});

describe("PostgreSQL idle-client errors", () => {
	it("handles the pool error without exposing the failed client's credentials", async () => {
		const pool = await capturePool({ connectionString: "postgres://localhost/emdash" });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const password = "idle-client-password";
		const client = {
			connectionParameters: {
				connectionString: `postgres://emdash:${password}@db.example.com/site`,
				password,
			},
		};
		const error = Object.assign(
			new Error(
				`connection reset by peer for postgres://emdash:${password}@db.example.com/site password=${password}`,
			),
			{ client, code: "ECONNRESET" },
		);

		expect(() => pool.emit("error", error, client)).not.toThrow();

		const output = inspect(consoleError.mock.calls, { depth: 10 });
		expect(output).toContain("ECONNRESET");
		expect(output).toContain("connection reset by peer");
		expect(output).not.toContain(password);
	});
});
