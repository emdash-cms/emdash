/**
 * Term assignments belong to the translation group, so permanent delete
 * removes them only with the group's last row, trashed rows included.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentPermanentDelete } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("handleContentPermanentDelete: term assignments", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;
	let taxonomies: TaxonomyRepository;
	let termId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		content = new ContentRepository(ctx.db);
		taxonomies = new TaxonomyRepository(ctx.db);
		const term = await taxonomies.create({ name: "tag", slug: "news", label: "News" });
		termId = term.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function assignmentsFor(group: string) {
		return ctx.db
			.selectFrom("content_taxonomies")
			.select("taxonomy_id")
			.where("collection", "=", "post")
			.where("entry_id", "=", group)
			.execute();
	}

	async function trashAndPurge(id: string) {
		expect(await content.delete("post", id)).toBe(true);
		const result = await handleContentPermanentDelete(ctx.db, "post", id);
		expect(result.success).toBe(true);
	}

	async function createTranslatedPost() {
		const en = await content.create({ type: "post", locale: "en", data: { title: "Hello" } });
		const de = await content.create({
			type: "post",
			locale: "de",
			translationOf: en.id,
			data: { title: "Hallo" },
		});
		await taxonomies.attachToEntry("post", en.id, termId);
		return { en, de, group: en.translationGroup! };
	}

	it("removes the assignments when the last translation is deleted", async () => {
		const post = await content.create({ type: "post", data: { title: "Only" } });
		await taxonomies.attachToEntry("post", post.id, termId);
		expect(await assignmentsFor(post.translationGroup!)).toHaveLength(1);

		await trashAndPurge(post.id);

		expect(await assignmentsFor(post.translationGroup!)).toEqual([]);
	});

	it("keeps the assignments while another translation exists", async () => {
		const { en, de, group } = await createTranslatedPost();

		await trashAndPurge(en.id);
		expect(await assignmentsFor(group)).toHaveLength(1);

		await trashAndPurge(de.id);
		expect(await assignmentsFor(group)).toEqual([]);
	});

	it("keeps the assignments while another translation is in the trash", async () => {
		const { en, de, group } = await createTranslatedPost();
		expect(await content.delete("post", de.id)).toBe(true);

		await trashAndPurge(en.id);

		expect(await assignmentsFor(group)).toHaveLength(1);
	});
});
