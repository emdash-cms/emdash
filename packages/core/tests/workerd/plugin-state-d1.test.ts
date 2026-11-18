import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { PluginStateRepository } from "../../src/plugins/state.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("PluginStateRepository.createActiveIfAbsent on D1", () => {
	it("reports an insert only for the caller that created the row", async () => {
		const repo = new PluginStateRepository(db);

		expect(await repo.createActiveIfAbsent("test-plugin", "1.0.0", "config")).toBe(true);
		expect(await repo.createActiveIfAbsent("test-plugin", "1.0.0", "config")).toBe(false);
		expect(await repo.get("test-plugin")).toMatchObject({ status: "active", source: "config" });
	});

	it("lets exactly one of several concurrent callers create the row", async () => {
		const repo = new PluginStateRepository(db);

		const results = await Promise.all(
			Array.from({ length: 5 }, () => repo.createActiveIfAbsent("test-plugin", "1.0.0", "config")),
		);

		expect(results.filter(Boolean)).toHaveLength(1);
	});
});

describe("plugin state generation on D1", () => {
	it("bumps atomically for writes and not for conditional no-ops", async () => {
		const repo = new PluginStateRepository(db);

		await repo.upsert("plugin", "1.0.0", "active");
		expect(await repo.getGeneration()).toBe(1n);

		await repo.upsert("plugin", "2.0.0", "active");
		expect(await repo.getGeneration()).toBe(2n);

		expect(await repo.createActiveIfAbsent("plugin", "3.0.0", "registry")).toBe(false);
		expect(await repo.delete("plugin", { version: "wrong" })).toBe(false);
		expect(await repo.getGeneration()).toBe(2n);

		expect(await repo.delete("plugin", { version: "2.0.0" })).toBe(true);
		expect(await repo.getSnapshot()).toEqual({ generation: 3n, states: [] });
	});
});
