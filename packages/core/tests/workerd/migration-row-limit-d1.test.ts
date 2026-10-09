import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { readMigrationLock } from "../../src/database/migration-lock.js";
import {
	createMigrator,
	getExactMigrationStatus,
	MigrationRowLimitError,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	const { error } = await createMigrator(db).migrateTo("078_menu_item_translation_groups");
	if (error) throw error;
	await new SchemaRegistry(db).createCollection({ slug: "posts", label: "Posts" });
	for (const id of ["post-1", "post-2", "post-3"]) {
		await sql`
			INSERT INTO ec_posts (id, slug, status, created_at, updated_at, version, locale, translation_group)
			VALUES (${id}, ${id}, 'draft', '2012-09-12T18:00:00', '2012-09-12T18:00:00', 1, 'en', ${id})
		`.execute(db);
	}
});

afterAll(async () => {
	await db.destroy();
});

describe("content row limit on D1", () => {
	it("refuses before it reaches the migration lock when the content exceeds the limit", async () => {
		const heldSince = Date.now() - 10 * 60_000;
		await sql`UPDATE _emdash_migrations_lock SET is_locked = ${heldSince}`.execute(db);

		await expect(runMigrations(db, { contentRowLimit: 2 })).rejects.toBeInstanceOf(
			MigrationRowLimitError,
		);

		expect(await readMigrationLock(db)).toBe(heldSince);
		expect((await getExactMigrationStatus(db)).pending[0]).toBe("079_datetime_normalization");
	});

	it("applies and releases the lock when the content fits the limit", async () => {
		const { applied } = await runMigrations(db, { contentRowLimit: 3 });

		expect(applied[0]).toBe("079_datetime_normalization");
		expect((await getExactMigrationStatus(db)).pending).toEqual([]);
		expect(await readMigrationLock(db)).toBeNull();
	});
});
