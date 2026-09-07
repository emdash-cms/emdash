import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	enforceRuntimeMigrationPolicy,
	normalizeMigrationConfig,
	PendingMigrationsError,
	resolveRuntimeMigrationMode,
} from "../../../src/database/migrations/policy.js";
import { MIGRATION_NAMES, runMigrations } from "../../../src/database/migrations/runner.js";
import { createTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

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

describe("runtime migration policy configuration", () => {
	it("defaults production and development to auto", () => {
		const config = normalizeMigrationConfig(undefined);

		expect(config).toEqual({ runtime: "auto" });
		expect(resolveRuntimeMigrationMode(config, { dev: false })).toBe("auto");
		expect(resolveRuntimeMigrationMode(config, { dev: true })).toBe("auto");
	});

	it("uses the development override without inheriting the production mode", () => {
		expect(resolveRuntimeMigrationMode({ runtime: "manual" }, { dev: true })).toBe("auto");
		expect(resolveRuntimeMigrationMode({ runtime: "manual", dev: "check" }, { dev: true })).toBe(
			"check",
		);
	});

	it("gives a validated environment override precedence", () => {
		expect(
			resolveRuntimeMigrationMode(
				{ runtime: "auto", dev: "auto" },
				{ dev: true, override: "manual" },
			),
		).toBe("manual");
		expect(() =>
			resolveRuntimeMigrationMode({ runtime: "auto" }, { dev: false, override: "later" }),
		).toThrow(/EMDASH_MIGRATIONS_MODE.*later/);
	});

	it("rejects invalid integration modes", () => {
		expect(() => normalizeMigrationConfig({ runtime: "later" })).toThrow(
			/migrations\.runtime.*later/,
		);
		expect(() => normalizeMigrationConfig({ runtime: "auto", dev: "later" })).toThrow(
			/migrations\.dev.*later/,
		);
	});
});

describe("runtime migration policy execution", () => {
	let db = createTestDatabase();

	beforeEach(() => {
		db = createTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("keeps auto on the existing single-query current-schema fast path", async () => {
		await runMigrations(db);
		const counter = new QueryCountingPlugin();

		await enforceRuntimeMigrationPolicy(db.withPlugin(counter), "auto");

		expect(counter.count).toBe(1);
	});

	it("checks directionally in one query and tolerates unknown applied names", async () => {
		await runMigrations(db);
		await db
			.insertInto("_emdash_migrations")
			.values({ name: "999_future", timestamp: new Date().toISOString() })
			.execute();
		const counter = new QueryCountingPlugin();

		await enforceRuntimeMigrationPolicy(db.withPlugin(counter), "check");

		expect(counter.count).toBe(1);
	});

	it("throws the pending names after one directional check", async () => {
		await runMigrations(db);
		const pending = MIGRATION_NAMES.at(-1)!;
		await db.deleteFrom("_emdash_migrations").where("name", "=", pending).execute();
		const counter = new QueryCountingPlugin();

		const result = enforceRuntimeMigrationPolicy(db.withPlugin(counter), "check");
		await expect(result).rejects.toMatchObject({ pending: [pending] });
		await expect(result).rejects.toBeInstanceOf(PendingMigrationsError);
		expect(counter.count).toBe(1);
	});

	it("manual issues no migration or status query", async () => {
		const counter = new QueryCountingPlugin();

		await enforceRuntimeMigrationPolicy(db.withPlugin(counter), "manual");

		expect(counter.count).toBe(0);
	});
});
