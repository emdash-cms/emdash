import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

describe("taxonomy publication on D1", () => {
	let db: Kysely<Database>;
	let content: ContentRepository;
	let taxonomy: TaxonomyRepository;

	beforeAll(() => {
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "tag_publish_d1",
			label: "D1 tag publication",
			supports: ["revisions"],
		});
		await registry.createField("tag_publish_d1", { slug: "title", label: "Title", type: "string" });
		content = new ContentRepository(db);
		taxonomy = new TaxonomyRepository(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	async function stageTag() {
		const entry = await content.create({
			type: "tag_publish_d1",
			slug: "hello",
			data: { title: "Hello" },
		});
		await content.publish("tag_publish_d1", entry.id);
		const term = await taxonomy.create({ name: "tag", slug: "internship", label: "Internship" });
		await content.restoreDraftRevision(
			"tag_publish_d1",
			entry.id,
			{ ...entry.data, _taxonomyDrafts: { tag: { before: [], after: [term.translationGroup] } } },
			"editor",
		);
		return { entry, term };
	}

	it("promotes staged terms with the live revision", async () => {
		const { entry, term } = await stageTag();
		expect(await taxonomy.getTermsForEntry("tag_publish_d1", entry.id, "tag")).toEqual([]);
		const published = await content.publish("tag_publish_d1", entry.id);
		expect(published.draftRevisionId).toBeNull();
		expect(
			(await taxonomy.getTermsForEntry("tag_publish_d1", entry.id, "tag")).map((item) => item.id),
		).toEqual([term.id]);
		const live = await new RevisionRepository(db).findById(published.liveRevisionId!);
		expect(live?.data).not.toHaveProperty("_taxonomyDrafts");
	});

	it("rolls back the live revision when the term write fails", async () => {
		const { entry } = await stageTag();
		const before = await content.findById("tag_publish_d1", entry.id);
		await sql`
			CREATE TRIGGER fail_tag_publish
			BEFORE INSERT ON content_taxonomies
			BEGIN SELECT RAISE(FAIL, 'term write failed'); END
		`.execute(db);
		await expect(content.publish("tag_publish_d1", entry.id)).rejects.toThrow();
		const after = await content.findById("tag_publish_d1", entry.id);
		expect(after?.liveRevisionId).toBe(before?.liveRevisionId);
		expect(after?.draftRevisionId).toBe(before?.draftRevisionId);
		expect(await taxonomy.getTermsForEntry("tag_publish_d1", entry.id, "tag")).toEqual([]);
	});
});
