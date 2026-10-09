import { env } from "cloudflare:test";
import { Kysely } from "kysely";
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
		await registry.createCollection({ slug: collectionSlug, label: "Full D1" });

		// D1 limits tables to 100 columns. The content table has 15 system columns,
		// so 85 ordinary TEXT fields should saturate the table.
		const D1_COLUMN_LIMIT = 100;
		const SYSTEM_COLUMNS = 15;
		const fieldCount = D1_COLUMN_LIMIT - SYSTEM_COLUMNS;

		for (let i = 0; i < fieldCount; i++) {
			await registry.createField(collectionSlug, {
				slug: `field_${String(i).padStart(3, "0")}`,
				label: `Field ${i}`,
				type: "string",
			});
		}

		// Adding one more field should hit the column limit, leaving no field row.
		await expect(
			registry.createField(collectionSlug, {
				slug: "overflow",
				label: "Overflow",
				type: "string",
			}),
		).rejects.toThrow();

		const fieldRow = await db
			.selectFrom("_emdash_fields")
			.where("slug", "=", "overflow")
			.selectAll()
			.executeTakeFirst();

		expect(fieldRow).toBeUndefined();
	});

	it("creates the rejected field once a column is freed", async () => {
		const collectionSlug = "full_d1_retry";
		await registry.createCollection({ slug: collectionSlug, label: "Full D1 Retry" });

		for (let i = 0; i < 85; i++) {
			await registry.createField(collectionSlug, {
				slug: `field_${String(i).padStart(3, "0")}`,
				label: `Field ${i}`,
				type: "string",
			});
		}

		await expect(
			registry.createField(collectionSlug, {
				slug: "overflow",
				label: "Overflow",
				type: "string",
			}),
		).rejects.toThrow();

		// Free a column by deleting another field.
		await registry.deleteField(collectionSlug, "field_000");

		const field = await registry.createField(collectionSlug, {
			slug: "overflow",
			label: "Overflow",
			type: "string",
		});

		expect(field.slug).toBe("overflow");
		expect(await registry.getField(collectionSlug, "overflow")).toBeDefined();
	});
});
