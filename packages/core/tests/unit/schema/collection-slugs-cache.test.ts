import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	filterToRegisteredCollections,
	primeRegisteredCollections,
} from "../../../src/schema/collection-slugs-cache.js";
import {
	createStalledDatabase,
	setupTestDatabaseWithCollections,
	setupTestDatabaseWithCompoundSelectLimit,
	teardownTestDatabase,
} from "../../utils/test-db.js";

describe("filterToRegisteredCollections", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await teardownTestDatabase(db);
	});

	it("does not strand later requests on a first query that never settles", async () => {
		const stalled = createStalledDatabase();
		const stranded = filterToRegisteredCollections(stalled.db, ["post"]);
		void stranded.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Past the single-flight reclaim deadline, the next reader takes over.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);

		try {
			expect(await filterToRegisteredCollections(db, ["post", "missing"])).toEqual(["post"]);
		} finally {
			stalled.abort();
		}
	});

	it("refetches a stale slug set once for parallel readers", async () => {
		const counted = await setupTestDatabaseWithCompoundSelectLimit(null);
		primeRegisteredCollections(["post"]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 120_000);
		counted.statements.length = 0;

		await Promise.all(
			[1, 2, 3].map(() => filterToRegisteredCollections(counted.db, ["post", "missing"])),
		);
		await counted.db.destroy();

		const slugReads = counted.statements.filter((source) => source.includes("_emdash_collections"));
		expect(slugReads).toHaveLength(1);
	});
});
