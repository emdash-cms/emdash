import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
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
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("does not scan content or FTS row counts on a cold search health check", async () => {
		// Each runtime has a fresh isolate-lifetime health cache.
		for (let isolate = 0; isolate < 2; isolate++) {
			const runtime = createTestRuntime(db);
			const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");
			executeQuery.mockClear();

			await runtime.ensureSearchHealthy();

			const statements = executeQuery.mock.calls.map(([query]) => query.sql);
			expect(statements.length).toBeGreaterThan(0);
			expect(statements.filter((statement) => /count\s*\(/i.test(statement))).toEqual([]);
			const result = await searchWithDb(db, "cthulhu", { collections: ["game"] });
			expect(result.items.map((item) => item.slug)).toEqual(["trail-of-cthulhu"]);
		}
	});

	it("repairs an index left empty by an interrupted rebuild", async () => {
		await ftsManager.dropFtsTable("game");
		await ftsManager.createFtsTable("game", ["title", "blurb"]);

		await createTestRuntime(db).ensureSearchHealthy();

		const repaired = await searchWithDb(db, "cthulhu", { collections: ["game"] });
		expect(repaired.items.map((item) => item.slug)).toEqual(["trail-of-cthulhu"]);
	});

	it("does not rebuild an empty collection on every cold runtime", async () => {
		await repo.delete("game", gameId);
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");

		await createTestRuntime(db).ensureSearchHealthy();

		const statements = executeQuery.mock.calls.map(([query]) => query.sql);
		expect(
			statements.filter((statement) => /CREATE|DROP|INSERT|count\s*\(/i.test(statement)),
		).toEqual([]);
	});

	it("leaves non-empty row-count drift repair to explicit verification", async () => {
		await repo.create({
			type: "game",
			slug: "another-game",
			status: "published",
			data: { title: "Another game" },
		});
		await sql`DELETE FROM ${sql.ref("_emdash_fts_game")} WHERE id = ${gameId}`.execute(db);

		await createTestRuntime(db).ensureSearchHealthy();
		expect((await searchWithDb(db, "cthulhu", { collections: ["game"] })).items).toEqual([]);

		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);
		const repaired = await searchWithDb(db, "cthulhu", { collections: ["game"] });
		expect(repaired.items.map((item) => item.slug)).toEqual(["trail-of-cthulhu"]);
	});

	it.each(["runtime", "explicit"])(
		"recreates a missing FTS table via %s verification",
		async (mode) => {
			expect(await ftsManager.ftsTableExists("game")).toBe(true);

			await ftsManager.dropFtsTable("game");

			expect(await ftsManager.ftsTableExists("game")).toBe(false);
			expect(
				await searchWithDb(db, "cthulhu", {
					collections: ["game"],
					status: "published",
				}),
			).toEqual({ items: [] });

			if (mode === "runtime") {
				await createTestRuntime(db).ensureSearchHealthy();
			} else {
				await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);
			}
			expect(await ftsManager.ftsTableExists("game")).toBe(true);

			const repaired = await searchWithDb(db, "cthulhu", {
				collections: ["game"],
				status: "published",
			});

			expect(repaired.items).toHaveLength(1);
			expect(repaired.items[0]?.slug).toBe("trail-of-cthulhu");
		},
	);

	it("keeps the FTS index in sync after soft delete", async () => {
		await expect(repo.delete("game", gameId)).resolves.toBe(true);
		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(0);
	});
});
