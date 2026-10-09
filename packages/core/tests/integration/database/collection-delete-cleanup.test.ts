import { afterEach, beforeEach, expect, it } from "vitest";

import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("collection delete shared-record cleanup", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("removes shared-table records when force-deleting a collection", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "cleanup", label: "Cleanup" });

		const collectionSlug = "cleanup";
		const entryId = "entry-1";
		const revisionId = "revision-1";
		const bylineId = "byline-1";
		const taxonomyId = "taxonomy-1";

		await ctx.db
			.insertInto("revisions")
			.values({ id: revisionId, collection: collectionSlug, entry_id: entryId, data: "{}" })
			.execute();

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- direct table insert in test
		await ctx.db
			.insertInto("ec_cleanup" as never)
			.values({
				id: entryId,
				slug: entryId,
				translation_group: entryId,
				live_revision_id: revisionId,
				draft_revision_id: revisionId,
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_seo")
			.values({ collection: collectionSlug, content_id: entryId, seo_title: "Title" })
			.execute();

		await ctx.db
			.insertInto("_emdash_revision_prune_queue")
			.values({ collection: collectionSlug, entry_id: entryId, revision_id: revisionId })
			.execute();

		await ctx.db
			.insertInto("users")
			.values({ id: "user-1", email: "user-1@example.com", role: 10 })
			.execute();

		await ctx.db
			.insertInto("_emdash_entry_locks")
			.values({
				collection: collectionSlug,
				entry_id: entryId,
				user_id: "user-1",
				token: "token-1",
				acquired_at: new Date().toISOString(),
				expires_at: new Date().toISOString(),
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_comments")
			.values({
				id: "comment-1",
				collection: collectionSlug,
				content_id: entryId,
				author_name: "Author",
				author_email: "author@example.com",
				body: "Comment body",
				status: "approved",
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_bylines")
			.values({
				id: bylineId,
				slug: bylineId,
				display_name: "Byline",
				translation_group: bylineId,
				is_guest: 0,
				bio: null,
				avatar_media_id: null,
				website_url: null,
				user_id: null,
				locale: "en",
			})
			.execute();
		await ctx.db
			.insertInto("_emdash_content_bylines")
			.values({
				id: "content-byline-1",
				collection_slug: collectionSlug,
				content_id: entryId,
				byline_id: bylineId,
				sort_order: 0,
			})
			.execute();

		await ctx.db
			.insertInto("taxonomies")
			.values({
				id: taxonomyId,
				name: "Term",
				slug: taxonomyId,
				label: "Term",
				parent_id: null,
				data: null,
				translation_group: taxonomyId,
				locale: "en",
			})
			.execute();
		await ctx.db
			.insertInto("content_taxonomies")
			.values({ collection: collectionSlug, entry_id: entryId, taxonomy_id: taxonomyId })
			.execute();

		await registry.deleteCollection(collectionSlug, { force: true });

		expect(
			await count(ctx.db.selectFrom("revisions").where("collection", "=", collectionSlug)),
		).toBe(0);
		expect(
			await count(ctx.db.selectFrom("_emdash_seo").where("collection", "=", collectionSlug)),
		).toBe(0);
		expect(
			await count(ctx.db.selectFrom("_emdash_comments").where("collection", "=", collectionSlug)),
		).toBe(0);
		expect(
			await count(
				ctx.db.selectFrom("_emdash_content_bylines").where("collection_slug", "=", collectionSlug),
			),
		).toBe(0);
		expect(
			await count(ctx.db.selectFrom("content_taxonomies").where("collection", "=", collectionSlug)),
		).toBe(0);
		expect(
			await count(
				ctx.db.selectFrom("_emdash_entry_locks").where("collection", "=", collectionSlug),
			),
		).toBe(0);
		expect(
			await count(
				ctx.db.selectFrom("_emdash_revision_prune_queue").where("collection", "=", collectionSlug),
			),
		).toBe(0);
	});
});

async function count(
	query: import("kysely").SelectQueryBuilder<never, never, unknown>,
): Promise<number> {
	const result = await query.select((eb) => eb.fn.countAll().as("count")).executeTakeFirst();
	return Number(result?.count ?? 0);
}
