import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "posts";
/** Three bound columns per assignment row, so 120 rows need 360 parameters. */
const TERM_COUNT = 120;

let db: Kysely<Database>;
let taxonomies: TaxonomyRepository;
let termIds: string[];

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Posts", labelSingular: "Post" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });

	taxonomies = new TaxonomyRepository(db);
	termIds = [];
	for (let i = 0; i < TERM_COUNT; i++) {
		// oxlint-disable-next-line no-await-in-loop -- sequential setup
		const term = await taxonomies.create({ name: "tag", slug: `tag-${i}`, label: `Tag ${i}` });
		termIds.push(term.id);
	}
});

afterAll(async () => {
	await db.destroy();
});

async function createEntry(title: string): Promise<string> {
	const result = await handleContentCreate(db, COLLECTION, { data: { title } });
	if (!result.success) throw new Error(`Failed to create entry: ${JSON.stringify(result)}`);
	return result.data!.item.id;
}

async function assignmentCount(entryId: string): Promise<number> {
	const terms = await taxonomies.getTermsForEntry(COLLECTION, entryId, "tag");
	return terms.length;
}

describe("term assignments on D1", () => {
	it("attaches more terms than fit in one statement", async () => {
		const entryId = await createEntry("Many tags");
		const groups = await Promise.all(
			termIds.map(async (id) => (await taxonomies.findById(id))!.translationGroup!),
		);

		const inserted = await taxonomies.attachGroupsToEntry(COLLECTION, entryId, groups);

		expect(inserted).toBe(TERM_COUNT);
		expect(await assignmentCount(entryId)).toBe(TERM_COUNT);
	});

	it("detaches more terms than fit in one statement", async () => {
		const entryId = await createEntry("Many tags, detached");
		const groups = await Promise.all(
			termIds.map(async (id) => (await taxonomies.findById(id))!.translationGroup!),
		);
		await taxonomies.attachGroupsToEntry(COLLECTION, entryId, groups);

		const removed = await taxonomies.detachGroupsFromEntry(COLLECTION, entryId, groups);

		expect(removed).toBe(TERM_COUNT);
		expect(await assignmentCount(entryId)).toBe(0);
	});

	it("sets and then clears more terms than fit in one statement", async () => {
		const entryId = await createEntry("Many tags, set");

		await taxonomies.setTermsForEntry(COLLECTION, entryId, "tag", termIds);
		expect(await assignmentCount(entryId)).toBe(TERM_COUNT);

		await taxonomies.setTermsForEntry(COLLECTION, entryId, "tag", []);
		expect(await assignmentCount(entryId)).toBe(0);
	});
});
