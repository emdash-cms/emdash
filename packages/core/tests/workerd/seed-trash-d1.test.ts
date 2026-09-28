import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);
});
afterAll(async () => {
	await db.destroy();
});

it.each(["skip", "update", "error"] as const)(
	"honors %s for trashed content on D1",
	async (onConflict) => {
		const collection = `trash_${onConflict}`;
		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: collection,
					label: "Trash test",
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
			],
			content: { [collection]: [{ id: "seed-entry", slug: "hello", data: { title: "Original" } }] },
		};
		await applySeed(db, seed, { includeContent: true });
		const repo = new ContentRepository(db);
		const original = await repo.findBySlug(collection, "hello", "en");
		expect(original).not.toBeNull();
		await repo.delete(collection, original!.id);
		seed.content![collection]![0]!.data.title = "Replacement";
		const apply = applySeed(
			db,
			{ ...seed, collections: undefined },
			{ includeContent: true, onConflict },
		);
		if (onConflict === "error") {
			await expect(apply).rejects.toThrow(/already exists \(in trash\)/);
		} else {
			expect((await apply).content).toEqual({ created: 0, skipped: 1, updated: 0 });
		}
		expect(await repo.findBySlug(collection, "hello", "en")).toBeNull();
		expect((await repo.findByIdIncludingTrashed(collection, original!.id))?.data.title).toBe(
			"Original",
		);
	},
);
