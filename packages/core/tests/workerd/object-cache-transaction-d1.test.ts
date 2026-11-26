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
	cache_transaction_rows: { id: string; title: string };
};

const namespace = "object-cache-transaction-d1-test";
const rowId = "row-1";
let db: Kysely<TestDatabase>;

function read(): Promise<string | null> {
	return cachedQuery({
		namespace,
		key: `row:${rowId}`,
		load: async () => {
			const row = await db
				.selectFrom("cache_transaction_rows")
				.select("title")
				.where("id", "=", rowId)
				.executeTakeFirst();
			return row?.title ?? null;
		},
	});
}

beforeAll(async () => {
	db = new Kysely<TestDatabase>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await db.schema
		.createTable("cache_transaction_rows")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("title", "text", (column) => column.notNull())
		.execute();
	await db.insertInto("cache_transaction_rows").values({ id: rowId, title: "OLD" }).execute();
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
});

afterAll(async () => {
	await waitForDeferredTasks();
	__setObjectCacheBackendForTests(null);
	await db.schema.dropTable("cache_transaction_rows").ifExists().execute();
	await db.destroy();
});

it("applies an invalidation as soon as it is made when D1 runs the callback without a transaction", async () => {
	await expect(read()).resolves.toBe("OLD");

	// The first call probes for transaction support, the second takes the
	// cached "unsupported" path. Both must bump at once.
	for (const title of ["NEW", "NEWER"]) {
		await withTransaction(db, async (trx) => {
			await trx
				.updateTable("cache_transaction_rows")
				.set({ title })
				.where("id", "=", rowId)
				.execute();
			invalidateObjectCache(namespace);
			// The update has already committed, so the bump must not wait for the
			// callback to finish: a cancelled request would never get there.
			await expect(read()).resolves.toBe(title);
		});
	}
});
