import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/handlers/content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
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
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "entries", label: "Entries" });
	await registry.createField("entries", { slug: "label", label: "Label", type: "string" });
	await registry.updateCollection("entries", { titleField: "label" });
});

afterAll(async () => {
	await db.destroy();
});

describe("content slug collisions on D1", () => {
	it.each([
		["48-byte base", "a".repeat(48)],
		["49-byte base", "a".repeat(49)],
		["long configured title", "This is a label that is comfortably over fifty characters"],
		["multibyte base", "界".repeat(17)],
	])("creates repeated entries with a %s", async (_name, label) => {
		const base = label.toLowerCase().replaceAll(" ", "-");
		for (const suffix of ["", "-1", "-2"]) {
			const result = await handleContentCreate(db, "entries", { data: { label } });
			expect(result).toMatchObject({
				success: true,
				data: { item: { slug: `${base}${suffix}`, data: { label } } },
			});
		}
		await expect(
			new ContentRepository(db).generateUniqueSlug("entries", label, "en"),
		).resolves.toBe(`${base}-3`);
	});
});
