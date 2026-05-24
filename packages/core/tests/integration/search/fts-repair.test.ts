import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("FTS repair", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let ftsManager: FTSManager;
	let gameId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		await registry.createCollection({
			slug: "game",
			label: "Games",
			labelSingular: "Game",
			supports: ["search"],
		});
		await registry.createField("game", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField("game", {
			slug: "blurb",
			label: "Blurb",
			type: "text",
			searchable: true,
		});

		const created = await repo.create({
			type: "game",
			slug: "trail-of-cthulhu",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: {
				title: "Trail of Cthulhu",
				blurb: "Investigative horror in the Cthulhu mythos.",
			},
		});
		gameId = created.id;

		await ftsManager.enableSearch("game");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("recreates a missing FTS table when search remains enabled", async () => {
		expect(await ftsManager.ftsTableExists("game")).toBe(true);

		await ftsManager.dropFtsTable("game");

		expect(await ftsManager.ftsTableExists("game")).toBe(false);
		expect(
			await searchWithDb(db, "cthulhu", {
				collections: ["game"],
				status: "published",
			}),
		).toEqual({ items: [] });

		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);
		expect(await ftsManager.ftsTableExists("game")).toBe(true);

		const repaired = await searchWithDb(db, "cthulhu", {
			collections: ["game"],
			status: "published",
		});

		expect(repaired.items).toHaveLength(1);
		expect(repaired.items[0]?.slug).toBe("trail-of-cthulhu");
	});

	it("keeps the FTS index in sync after soft delete", async () => {
		await expect(repo.delete("game", gameId)).resolves.toBe(true);
		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(0);
	});
});
