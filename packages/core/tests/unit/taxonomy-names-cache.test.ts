import type { Kysely, KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTaxonomyCreate } from "../../src/api/handlers/taxonomies.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("taxonomy name mappings background cache", () => {
	let db: Kysely<Database>;
	let definitionReads: number;
	let slug: string;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const original = await setupTestDatabaseWithCollections();
		definitionReads = 0;
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				const sql = original.getExecutor().compileQuery(args.node, args.queryId).sql;
				if (/^select/i.test(sql) && sql.includes('from "_emdash_taxonomy_defs"')) definitionReads++;
				return args.node;
			},
			transformResult: (args) => Promise.resolve(args.result),
		};
		db = original.withPlugin(plugin);
		resetTaxonomyNamesCache();
		const result = await handleTaxonomyCreate(db, {
			name: "topic",
			label: "Topics",
			collections: ["post"],
		});
		if (!result.success) throw new Error("Failed to create taxonomy");
		const taxonomies = new TaxonomyRepository(db);
		const term = await taxonomies.create({ name: "topic", slug: "news", label: "News" });
		const post = await new ContentRepository(db).create({
			type: "post",
			slug: "announcement",
			data: { title: "Announcement" },
			status: "published",
		});
		await taxonomies.attachToEntry("post", post.id, term.id);
		slug = post.slug;
		definitionReads = 0;
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		resetTaxonomyNamesCache();
		vi.useRealTimers();
		await teardownTestDatabase(db);
	});

	function attach(attached: boolean) {
		return db
			.updateTable("_emdash_taxonomy_def_groups")
			.set({ collections: JSON.stringify(attached ? ["post"] : []) })
			.where("name", "=", "topic")
			.execute();
	}

	function read(where: Record<string, string>, isolated = false) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db, dbIsIsolated: isolated }, () =>
			loader.loadCollection!({ filter: { type: "post", where } }),
		);
	}

	it("refreshes remote mapping changes after 30 seconds without a render-time reload", async () => {
		await attach(false);
		expect((await read({ title: "Announcement" })).entries?.map((entry) => entry.id)).toContain(
			slug,
		);
		expect(definitionReads).toBe(1);
		await attach(true);
		vi.setSystemTime(Date.now() + 29_999);
		await read({ title: "Announcement" });
		expect(definitionReads).toBe(1);
		vi.setSystemTime(Date.now() + 1);
		// The expired snapshot still classifies topic as a field until refresh finishes.
		expect((await read({ topic: "news" })).entries).toHaveLength(0);
		await waitForDeferredTasks();
		expect((await read({ topic: "news" })).entries?.map((entry) => entry.id)).toContain(slug);
		expect(definitionReads).toBe(2);
	});

	it("invalidates a local mapping change immediately", async () => {
		await attach(false);
		await read({ title: "Announcement" });
		await attach(true);
		resetTaxonomyNamesCache();
		expect((await read({ topic: "news" })).entries?.map((entry) => entry.id)).toContain(slug);
		expect(definitionReads).toBe(2);
	});

	it("does not reuse mappings across isolated database requests", async () => {
		for (let i = 0; i < 2; i++) {
			expect((await read({ topic: "news" }, true)).entries?.map((entry) => entry.id)).toContain(
				slug,
			);
		}
		expect(definitionReads).toBe(2);
	});
});
