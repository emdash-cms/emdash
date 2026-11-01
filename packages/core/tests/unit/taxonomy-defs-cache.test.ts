import type { Kysely, KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTaxonomyCreate } from "../../src/api/handlers/taxonomies.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { runWithContext } from "../../src/request-context.js";
import { getTaxonomyDefs, invalidateTaxonomyDefsCache } from "../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("taxonomy definitions background cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		db = await setupTestDatabaseWithCollections();
		invalidateTaxonomyDefsCache();
		const result = await handleTaxonomyCreate(db, {
			name: "topic",
			label: "Original",
			collections: ["post"],
		});
		if (!result.success) throw new Error("Failed to create taxonomy");
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		invalidateTaxonomyDefsCache();
		vi.restoreAllMocks();
		vi.useRealTimers();
		await teardownTestDatabase(db);
	});

	const label = (defs: Awaited<ReturnType<typeof getTaxonomyDefs>>) =>
		defs.find((definition) => definition.name === "topic")?.label;
	const read = (database: Kysely<Database>) =>
		runWithContext({ editMode: false, db: database }, () => getTaxonomyDefs());
	const update = () =>
		db
			.updateTable("_emdash_taxonomy_defs")
			.set({ label: "Updated" })
			.where("name", "=", "topic")
			.execute();

	it("serves an expired snapshot and refreshes a remote change in the background", async () => {
		expect(label(await read(db))).toBe("Original");
		await update();
		vi.setSystemTime(Date.now() + 29_999);
		expect(label(await read(db))).toBe("Original");
		vi.setSystemTime(Date.now() + 1);
		expect(label(await read(db))).toBe("Original");
		await waitForDeferredTasks();
		expect(label(await read(db))).toBe("Updated");
	});

	it("retains the last good snapshot after a failed refresh and retries later", async () => {
		expect(label(await read(db))).toBe("Original");
		await update();
		let fail = true;
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				const sql = db.getExecutor().compileQuery(args.node, args.queryId).sql;
				if (fail && /^select/i.test(sql) && sql.includes('from "_emdash_taxonomy_defs"')) {
					fail = false;
					throw new Error("temporary database outage");
				}
				return args.node;
			},
			transformResult: (args) => Promise.resolve(args.result),
		};
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.setSystemTime(Date.now() + 30_000);
		expect(label(await read(db.withPlugin(plugin)))).toBe("Original");
		await waitForDeferredTasks();
		expect(error).toHaveBeenCalledOnce();
		expect(label(await read(db))).toBe("Original");
		vi.setSystemTime(Date.now() + 30_000);
		expect(label(await read(db))).toBe("Original");
		await waitForDeferredTasks();
		expect(label(await read(db))).toBe("Updated");
	});

	it("observes explicit local invalidation immediately", async () => {
		await read(db);
		await update();
		invalidateTaxonomyDefsCache();
		expect(label(await read(db))).toBe("Updated");
	});
});
