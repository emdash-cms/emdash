import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { activateMediaUsageCapture } from "../../src/media/usage/activation.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

vi.mock("virtual:emdash/dialect", () => ({
	executeCollectionDeletionGuard: (
		_config: unknown,
		input: Parameters<typeof executeCollectionDeletionGuard>[1],
	) => executeCollectionDeletionGuard({ binding: "DB" }, input),
}));

let db: Kysely<Database>;
let registry: SchemaRegistry;

const D1_COLUMN_LIMIT = 100;

async function getContentTableColumns(collectionSlug: string): Promise<string[]> {
	const tableName = `ec_${collectionSlug}`;
	const result = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(tableName)})`.execute(db);
	return result.rows.map((row) => row.name);
}

async function fillCollectionToD1ColumnLimit(collectionSlug: string): Promise<void> {
	const systemColumnCount = (await getContentTableColumns(collectionSlug)).length;
	const fieldCount = D1_COLUMN_LIMIT - systemColumnCount;

	for (let i = 0; i < fieldCount; i++) {
		await registry.createField(collectionSlug, {
			slug: `field_${String(i).padStart(3, "0")}`,
			label: `Field ${i}`,
			type: "string",
		});
	}
}

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	await activateMediaUsageCapture(db, { writersDrained: true });
	registry = new SchemaRegistry(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("createField at D1's column cap", () => {
	it("leaves no field row behind when the column cannot be added", async () => {
		const collectionSlug = "full_d1";
		const collection = await registry.createCollection({ slug: collectionSlug, label: "Full D1" });
		await fillCollectionToD1ColumnLimit(collectionSlug);

		await expect(
			registry.createField(collectionSlug, {
				slug: "overflow",
				label: "Overflow",
				type: "string",
			}),
		).rejects.toThrow(/too many columns/i);

		const fieldRow = await db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collection.id)
			.where("slug", "=", "overflow")
			.selectAll()
			.executeTakeFirst();

		expect(fieldRow).toBeUndefined();
		expect(await registry.getField(collectionSlug, "overflow")).toBeNull();
	});

	it("creates the rejected field once a column is freed", async () => {
		const collectionSlug = "full_d1_retry";
		await registry.createCollection({ slug: collectionSlug, label: "Full D1 Retry" });
		await fillCollectionToD1ColumnLimit(collectionSlug);

		await expect(
			registry.createField(collectionSlug, {
				slug: "overflow",
				label: "Overflow",
				type: "string",
			}),
		).rejects.toThrow(/too many columns/i);

		await registry.deleteField(collectionSlug, "field_000");

		const field = await registry.createField(collectionSlug, {
			slug: "overflow",
			label: "Overflow",
			type: "string",
		});

		expect(field.slug).toBe("overflow");
		expect(await registry.getField(collectionSlug, "overflow")).toEqual(field);
		expect(await getContentTableColumns(collectionSlug)).toContain("overflow");
	});

	it("preserves field metadata when post-column invalidation fails", async () => {
		const collectionSlug = "post_column_failure";
		await registry.createCollection({
			slug: collectionSlug,
			label: "Post-column failure",
		});

		await sql`
			CREATE TRIGGER post_column_invalidation_failure
			AFTER UPDATE OF status ON _emdash_media_usage_index_status
			WHEN EXISTS (
				SELECT 1 FROM _emdash_fields
				WHERE collection_id = NEW.collection_id AND slug = 'post_failure'
			)
			BEGIN
				SELECT RAISE(ABORT, 'post-column invalidation failed');
			END
		`.execute(db);

		await expect(
			registry.createField(collectionSlug, {
				slug: "post_failure",
				label: "Post failure",
				type: "string",
			}),
		).rejects.toThrow(/post-column invalidation failed/i);

		expect(await registry.getField(collectionSlug, "post_failure")).not.toBeNull();
		expect(await getContentTableColumns(collectionSlug)).toContain("post_failure");
		await sql`DROP TRIGGER post_column_invalidation_failure`.execute(db);
	});
});
