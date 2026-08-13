/**
 * Plugin storage query/count with `where` filters, on both dialects (#920).
 *
 * The filtered paths wrapped the JSON-extraction predicate in `(...) = 1`.
 * SQLite coerces booleans to integers so that worked, but Postgres has a
 * strict boolean type and rejected every filtered list()/count() with
 * "operator does not exist: boolean = integer". This runs the filtered
 * paths end-to-end on both dialects to guard the predicate shape.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

interface ProviderDoc {
	provider: string;
	active: boolean;
	priority: number;
}

describeEachDialect("plugin storage filtered query/count (#920)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function makeRepo() {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- dialect context db vs Database type
		const db = ctx.db as unknown as Kysely<Database>;
		return new PluginStorageRepository<ProviderDoc>(db, "emdash-smtp", "providers", [
			"provider",
			"priority",
		]);
	}

	async function seed(repo: PluginStorageRepository<ProviderDoc>) {
		await repo.put("p1", { provider: "resend", active: true, priority: 1 });
		await repo.put("p2", { provider: "sendgrid", active: false, priority: 2 });
		await repo.put("p3", { provider: "resend", active: false, priority: 3 });
	}

	it("query() with a where filter returns matching documents", async () => {
		const repo = makeRepo();
		await seed(repo);

		const result = await repo.query({ where: { provider: "resend" } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p1", "p3"]);
	});

	it("query() combines where with orderBy", async () => {
		const repo = makeRepo();
		await seed(repo);

		const result = await repo.query({
			where: { provider: "resend" },
			orderBy: { priority: "desc" },
		});
		expect(result.items.map((i) => i.id)).toEqual(["p3", "p1"]);
	});

	it("query() supports operator objects in where", async () => {
		const repo = makeRepo();
		await seed(repo);

		const result = await repo.query({ where: { priority: { gt: 1 } } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p2", "p3"]);
	});

	it("count() with a where filter counts matching documents", async () => {
		const repo = makeRepo();
		await seed(repo);

		expect(await repo.count({ provider: "resend" })).toBe(2);
		expect(await repo.count({ provider: "sendgrid" })).toBe(1);
		expect(await repo.count({ provider: "nope" })).toBe(0);
	});
});
