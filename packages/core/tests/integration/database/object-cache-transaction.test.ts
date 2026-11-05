import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { withTransaction } from "../../../src/database/transaction.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	contentNamespaces,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { createPostFixture } from "../../utils/fixtures.js";
import {
	hasPgTestDatabase,
	setupTestPostgresDatabaseWithCollections,
	teardownTestPostgresDatabase,
	type PgTestContext,
} from "../../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

describe.skipIf(!hasPgTestDatabase)("object cache: content writes inside a transaction", () => {
	let ctx: PgTestContext;

	beforeEach(async () => {
		ctx = await setupTestPostgresDatabaseWithCollections();
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 1000, defaultTtl: 3600 });
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestPostgresDatabase(ctx);
	});

	it("does not keep a value read before the write committed", async () => {
		const repo = new ContentRepository(ctx.db);
		const post = await repo.create(createPostFixture({ data: { title: "Old" } }));

		const readTitle = () =>
			cachedQuery({
				namespace: contentNamespaces("post"),
				key: `entry:${post.id}`,
				load: async () => (await repo.findById("post", post.id))?.data.title,
			});

		await withTransaction(ctx.db, async (trx) => {
			await new ContentRepository(trx).update("post", post.id, { data: { title: "New" } });
			// A concurrent render outside the transaction still sees the committed row.
			expect(await readTitle()).toBe("Old");
			await flush();
		});
		await flush();

		expect(await readTitle()).toBe("New");
	});
});
