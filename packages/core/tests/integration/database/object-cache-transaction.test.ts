import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { withTransaction } from "../../../src/database/transaction.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	contentNamespaces,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../../utils/test-db.js";

function createTestCache(): ObjectCacheBackend {
	const values = new Map<string, string>();
	return {
		get: async (key) => values.get(key) ?? null,
		set: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
}

async function readTitle(db: Kysely<Database>, id: string): Promise<string | null> {
	const row = await db
		.selectFrom("ec_post")
		.select("title")
		.where("id", "=", id)
		.executeTakeFirst();
	return row?.title ?? null;
}

async function primeTitle(db: Kysely<Database>, id: string): Promise<string | null> {
	return cachedQuery({
		namespace: contentNamespaces("post"),
		key: `entry:${id}`,
		load: () => readTitle(db, id),
	});
}

describeEachDialect("object-cache transaction boundaries", (dialect: DialectName) => {
	let ctx: DialectTestContext;
	let itemId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		__setObjectCacheBackendForTests(createTestCache(), { defaultTtl: 3600, revalidate: 0 });

		itemId = "01J00000000000000000000000";
		await new ContentRepository(ctx.db).create({
			id: itemId,
			type: "post",
			slug: "cached-post",
			data: { title: "OLD", content: [] },
		});
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		__setObjectCacheBackendForTests(null);
		await teardownForDialect(ctx);
	});

	it.skipIf(dialect !== "postgres").each([
		{ name: "before commit", releaseLoadAfterCommit: false, nested: false },
		{ name: "after commit", releaseLoadAfterCommit: true, nested: false },
		{ name: "after a nested update", releaseLoadAfterCommit: false, nested: true },
	])(
		"does not let a cold read $name poison the post-commit cache",
		async ({ releaseLoadAfterCommit, nested }) => {
			let releaseWriter!: () => void;
			let releaseLoad!: () => void;
			let markUpdated!: () => void;
			let markLoaded!: () => void;
			const held = new Promise<void>((resolve) => {
				releaseWriter = resolve;
			});
			const allowLoadToReturn = new Promise<void>((resolve) => {
				releaseLoad = resolve;
			});
			const updated = new Promise<void>((resolve) => {
				markUpdated = resolve;
			});
			const loaded = new Promise<void>((resolve) => {
				markLoaded = resolve;
			});
			const writer = withTransaction(ctx.db, async (trx) => {
				if (nested) {
					await withTransaction(trx, async (inner) => {
						await new ContentRepository(inner).update("post", itemId, {
							data: { title: "NEW" },
						});
					});
				} else {
					await new ContentRepository(trx).update("post", itemId, {
						data: { title: "NEW" },
					});
				}
				markUpdated();
				await held;
			});

			try {
				await Promise.race([updated, writer]);
				const reader = cachedQuery({
					namespace: contentNamespaces("post"),
					key: `entry:${itemId}`,
					load: async () => {
						const title = await readTitle(ctx.db, itemId);
						markLoaded();
						if (releaseLoadAfterCommit) await allowLoadToReturn;
						return title;
					},
				});
				await Promise.race([loaded, reader]);
				if (releaseLoadAfterCommit) {
					releaseWriter();
					await writer;
					releaseLoad();
				}
				if (!releaseLoadAfterCommit) releaseLoad();
				await expect(reader).resolves.toBe("OLD");
				await waitForDeferredTasks();
				if (releaseLoadAfterCommit) {
					await expect(primeTitle(ctx.db, itemId)).resolves.toBe("NEW");
				} else {
					releaseWriter();
					await writer;
					await expect(primeTitle(ctx.db, itemId)).resolves.toBe("NEW");
				}
			} finally {
				releaseLoad();
				releaseWriter();
				await writer;
			}
			await waitForDeferredTasks();
			await expect(primeTitle(ctx.db, itemId)).resolves.toBe("NEW");
		},
	);

	it("bypasses a warm cache for transaction-local reads and keeps rolled-back data out", async () => {
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("OLD");
		await expect(
			withTransaction(ctx.db, async (trx) => {
				await new ContentRepository(trx).update("post", itemId, {
					data: { title: "UNCOMMITTED" },
				});
				await expect(
					cachedQuery({
						namespace: contentNamespaces("post"),
						key: `entry:${itemId}`,
						load: () => readTitle(trx, itemId),
					}),
				).resolves.toBe("UNCOMMITTED");
				await expect(
					cachedQuery({
						namespace: contentNamespaces("post"),
						key: `cold:${itemId}`,
						load: () => readTitle(trx, itemId),
					}),
				).resolves.toBe("UNCOMMITTED");
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");

		await waitForDeferredTasks();
		await expect(
			cachedQuery({
				namespace: contentNamespaces("post"),
				key: `cold:${itemId}`,
				load: () => readTitle(ctx.db, itemId),
			}),
		).resolves.toBe("OLD");
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("OLD");
	});

	it("makes committed values visible after a successful transaction", async () => {
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("OLD");
		await withTransaction(ctx.db, async (trx) => {
			await new ContentRepository(trx).update("post", itemId, {
				data: { title: "COMMITTED" },
			});
		});
		await waitForDeferredTasks();
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("COMMITTED");
	});

	it("shares the invalidation scope across nested transactions", async () => {
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("OLD");
		await withTransaction(ctx.db, async (outer) => {
			await withTransaction(outer, async (inner) => {
				await new ContentRepository(inner).update("post", itemId, {
					data: { title: "NESTED" },
				});
			});
		});
		await waitForDeferredTasks();
		await expect(primeTitle(ctx.db, itemId)).resolves.toBe("NESTED");
	});
});
