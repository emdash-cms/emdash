import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { addFocalColumnIfMissing } from "../../../../src/database/migrations/073_media_focal_point.js";

describe("073_media_focal_point migration", () => {
	let db: Kysely<Record<string, never>> | undefined;

	afterEach(async () => {
		await db?.destroy();
	});

	it("accepts a duplicate-column error when a concurrent migrator added the column", async () => {
		const sqlite = new BetterSqlite3(":memory:");
		sqlite.exec("CREATE TABLE media (id TEXT PRIMARY KEY)");
		db = new Kysely<Record<string, never>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		await expect(
			addFocalColumnIfMissing(db, "focal_x", async () => {
				await db!.schema.alterTable("media").addColumn("focal_x", "real").execute();
				throw new Error("migration failed", {
					cause: new Error("duplicate column name: focal_x"),
				});
			}),
		).resolves.toBeUndefined();
	});
});
