import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import { DOSqlDialect } from "../../../cloudflare/src/db/do-sql-dialect.js";
import type { EmDashDBStub } from "../../../cloudflare/src/db/do-sql-types.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { PluginStateRepository } from "../../src/plugins/state.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		PLUGIN_GENERATION_DB: DurableObjectNamespace;
	}
}

let db: Kysely<Database>;

beforeEach(async () => {
	const id = env.PLUGIN_GENERATION_DB.idFromName(crypto.randomUUID());
	const stub = env.PLUGIN_GENERATION_DB.get(id) as unknown as EmDashDBStub;
	db = new Kysely<Database>({
		dialect: new DOSqlDialect({ resolveStub: () => stub }),
	});
	await runMigrations(db);
});

describe("plugin state generation on a Durable Object SQL database", () => {
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

	it("rolls back the state write when generation publishing fails", async () => {
		await db.schema.dropTable("options").ifExists().execute();
		const repo = new PluginStateRepository(db);

		await expect(repo.upsert("failedPlugin", "1.0.0", "active")).rejects.toThrow();
		expect(await db.selectFrom("_plugin_state").select("plugin_id").execute()).toEqual([]);
	});
});
