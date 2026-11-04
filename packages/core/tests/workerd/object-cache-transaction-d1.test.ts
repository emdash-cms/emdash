import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { withTransaction } from "../../src/database/transaction.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	invalidateObjectCache,
} from "../../src/object-cache/index.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

type TestDatabase = {
	cache_transaction_rows: {
		id: string;
		title: string;
	};
};

const namespace = "object-cache-transaction-d1-test";
const rowId = "row-1";
let db: Kysely<TestDatabase>;

async function readTitle(queryDb: Kysely<TestDatabase>): Promise<string | null> {
	const row = await queryDb
		.selectFrom("cache_transaction_rows")
		.select("title")
		.where("id", "=", rowId)
		.executeTakeFirst();
	return row?.title ?? null;
}

beforeAll(async () => {
	db = new Kysely<TestDatabase>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
	});
	await db.schema
		.createTable("cache_transaction_rows")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("title", "text", (column) => column.notNull())
		.execute();
	await db.insertInto("cache_transaction_rows").values({ id: rowId, title: "OLD" }).execute();
});

afterAll(async () => {
	await waitForDeferredTasks();
	__setObjectCacheBackendForTests(null);
	await db.schema.dropTable("cache_transaction_rows").ifExists().execute();
	await db.destroy();
});

it("invalidates after a partially applied D1 transaction callback fails", async () => {
	const values = new Map<string, string>();
	__setObjectCacheBackendForTests(
		{
			get: async (key) => values.get(key) ?? null,
			set: async (key, value) => {
				values.set(key, value);
			},
			delete: async (key) => {
				values.delete(key);
			},
		},
		{ defaultTtl: 3600, revalidate: 0 },
	);

	const read = (queryDb: Kysely<TestDatabase>) =>
		cachedQuery({
			namespace,
			key: `row:${rowId}`,
			load: () => readTitle(queryDb),
		});

	await expect(read(db)).resolves.toBe("OLD");
	await waitForDeferredTasks();

	await expect(
		withTransaction(db, async (trx) => {
			await trx
				.updateTable("cache_transaction_rows")
				.set({ title: "NEW" })
				.where("id", "=", rowId)
				.execute();
			invalidateObjectCache(namespace);
			await expect(read(trx)).resolves.toBe("NEW");
			throw new Error("partial failure");
		}),
	).rejects.toThrow("partial failure");

	await waitForDeferredTasks();
	await expect(read(db)).resolves.toBe("NEW");
});
