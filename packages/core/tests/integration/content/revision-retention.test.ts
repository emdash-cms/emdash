import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));
vi.mock(
	"virtual:emdash/object-cache",
	() => ({ createObjectCache: undefined, objectCacheConfig: {} }),
	{ virtual: true },
);

import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function flushDeferred(): Promise<void> {
	const tasks = deferred.splice(0);
	for (const task of tasks) await task();
}

describe("revision retention without scheduled cleanup", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		deferred.length = 0;
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		deferred.length = 0;
		await teardownTestDatabase(db);
	});

	it("bounds history through request-lifetime work without a scheduled tick", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Initial" },
			slug: "bounded-history",
		});
		expect(created.success).toBe(true);
		const entryId = created.data!.item.id;
		const revisions = new RevisionRepository(db);

		for (let index = 0; index < 50; index++) {
			await revisions.create({
				collection: "posts",
				entryId,
				data: { title: `Version ${index}` },
			});
		}

		const saved = await runtime.handleContentUpdate("posts", entryId, {
			data: { title: "Version 50" },
		});
		expect(saved.success).toBe(true);
		expect(await revisions.countByEntry("posts", entryId)).toBe(51);

		await flushDeferred();

		expect(await revisions.countByEntry("posts", entryId)).toBe(50);
	});
});
