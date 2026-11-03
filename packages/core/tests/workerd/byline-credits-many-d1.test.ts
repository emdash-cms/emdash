import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/handlers/content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "many_byline_credits";
let db: Kysely<Database>;
let bylines: BylineRepository;
let content: ContentRepository;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	bylines = new BylineRepository(db);
	content = new ContentRepository(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Many credits" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
});

afterAll(async () => {
	await db.destroy();
});

async function createContent() {
	const result = await handleContentCreate(db, COLLECTION, { data: { title: "Many credits" } });
	if (!result.success) throw new Error("Failed to create content fixture");
	return result.data.item;
}

async function createBylines(count: number) {
	return Promise.all(
		Array.from({ length: count }, (_, index) =>
			bylines.create({ slug: `credit-${index}`, displayName: `Credit ${index}` }),
		),
	);
}

describe("content byline credits on D1", () => {
	it("sets more than 100 credits in order, preserving role labels and the primary pointer", async () => {
		const entry = await createContent();
		const credits = await createBylines(105);
		const assigned = await bylines.setContentBylines(
			COLLECTION,
			entry.id,
			credits.map((byline, index) => ({
				bylineId: byline.id,
				roleLabel: index % 10 === 0 ? `Role ${index}` : undefined,
			})),
		);

		expect(assigned).toHaveLength(105);
		expect(assigned.map((credit) => credit.byline.id)).toEqual(credits.map((byline) => byline.id));
		expect(assigned.map((credit) => credit.roleLabel)).toEqual(
			credits.map((_, index) => (index % 10 === 0 ? `Role ${index}` : null)),
		);
		expect((await content.findById(COLLECTION, entry.id))?.primaryBylineId).toBe(
			credits[0]?.translationGroup,
		);
	});

	it("rejects an unknown id in a later batch without replacing existing credits", async () => {
		const entry = await createContent();
		const credits = await createBylines(105);
		await bylines.setContentBylines(COLLECTION, entry.id, [
			{ bylineId: credits[0]!.id, roleLabel: "Lead" },
		]);
		const before = await bylines.getContentBylines(COLLECTION, entry.id);
		const beforePrimary = (await content.findById(COLLECTION, entry.id))?.primaryBylineId;

		await expect(
			bylines.setContentBylines(COLLECTION, entry.id, [
				...credits.map((byline) => ({ bylineId: byline.id })),
				{ bylineId: "missing-byline" },
			]),
		).rejects.toThrow("One or more byline IDs do not exist");

		expect(await bylines.getContentBylines(COLLECTION, entry.id)).toEqual(before);
		expect((await content.findById(COLLECTION, entry.id))?.primaryBylineId).toBe(beforePrimary);
	});

	it("deduplicates locale siblings across batches and clears credits for an empty list", async () => {
		const entry = await createContent();
		const anchor = await bylines.create({
			slug: "translated-credit",
			displayName: "English",
			locale: "en",
		});
		const sibling = await bylines.create({
			slug: "translated-credit-fr",
			displayName: "French",
			locale: "fr",
			translationOf: anchor.id,
		});
		const credits = await createBylines(51);

		const assigned = await bylines.setContentBylines(COLLECTION, entry.id, [
			{ bylineId: sibling.id, roleLabel: "French" },
			...credits.map((byline) => ({ bylineId: byline.id })),
			{ bylineId: sibling.id, roleLabel: "French duplicate" },
			{ bylineId: anchor.id, roleLabel: "English duplicate" },
		]);
		expect(assigned).toHaveLength(53);
		const stored = await db
			.selectFrom("_emdash_content_bylines")
			.select(["byline_id", "role_label", "sort_order"])
			.where("content_id", "=", entry.id)
			.orderBy("sort_order")
			.execute();
		expect(stored).toHaveLength(52);
		expect(stored[0]).toEqual({
			byline_id: anchor.translationGroup,
			role_label: "French",
			sort_order: 0,
		});
		expect(stored.slice(1).map((row) => row.byline_id)).toEqual(
			credits.map((byline) => byline.translationGroup),
		);

		expect(await bylines.setContentBylines(COLLECTION, entry.id, [])).toEqual([]);
		expect((await content.findById(COLLECTION, entry.id))?.primaryBylineId).toBeNull();
	});
});
