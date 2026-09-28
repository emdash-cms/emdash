import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage incremental work migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("registers expansion without activating capture or backfilling work", async () => {
		const migration = await ctx.db
			.selectFrom("_emdash_migrations")
			.select("name")
			.where("name", "=", "063_media_usage_incremental_work")
			.executeTakeFirst();
		expect(migration).toBeDefined();

		const activation = await ctx.db
			.selectFrom("_emdash_media_usage_activation")
			.select(["state", "collection_cursor", "activated_at"])
			.executeTakeFirstOrThrow();
		expect(activation).toEqual({
			state: "expanded",
			collection_cursor: null,
			activated_at: null,
		});

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await sql`INSERT INTO ${sql.ref("ec_posts")} (id, slug) VALUES ('entry-1', 'entry-1')`.execute(
			ctx.db,
		);

		const work = await ctx.db.selectFrom("_emdash_media_usage_work").selectAll().execute();
		expect(work).toEqual([]);
	});

	it("keeps V1 collection deletion available after rolling back incremental capture", async () => {
		const reconciliationMigration =
			await import("../../../src/database/migrations/066_media_usage_reconciliation.js");
		await reconciliationMigration.down(ctx.db);
		const collectionDeletionMigration =
			await import("../../../src/database/migrations/065_media_usage_collection_deletion.js");
		await collectionDeletionMigration.down(ctx.db);
		const incrementalMigration =
			await import("../../../src/database/migrations/063_media_usage_incremental_work.js");
		await incrementalMigration.down(ctx.db);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "legacy", label: "Legacy" });

		await registry.deleteCollection("legacy", { force: true });

		expect(await registry.getCollection("legacy")).toBeNull();
	});

	it("upgrades and reruns without rewriting legacy evidence or inventing work", async () => {
		const reconciliationMigration =
			await import("../../../src/database/migrations/066_media_usage_reconciliation.js");
		await reconciliationMigration.down(ctx.db);
		const collectionDeletionMigration =
			await import("../../../src/database/migrations/065_media_usage_collection_deletion.js");
		await collectionDeletionMigration.down(ctx.db);
		const migration =
			await import("../../../src/database/migrations/063_media_usage_incremental_work.js");
		await migration.down(ctx.db);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		const collection = await registry.getCollection("posts");
		if (!collection) throw new Error("Expected posts collection");

		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values([
				{
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "posts",
					status: "complete",
					completed_at: "2026-08-01T12:00:00.000Z",
				},
				{
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "deleted_collection",
					status: "complete",
				},
			])
			.execute();

		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: "content:posts:entry-1:columns",
				source_type: "content",
				collection_slug: "posts",
				content_id: "entry-1",
				source_variant: "columns",
				locale: "en",
				translation_group: "translation-1",
				content_slug: "entry-1",
				content_title: "Legacy title",
				content_status: "published",
				content_scheduled_at: null,
				content_deleted_at: null,
				revision_id: null,
				current_generation: "generation-1",
				source_fingerprint: "legacy-fingerprint",
			})
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "usage-1",
				source_key: "content:posts:entry-1:columns",
				generation: "generation-1",
				field_slug: "body",
				field_path: "body[0]",
				reference_type: "local",
				media_id: "media-1",
				provider_asset_id: "media-1",
			})
			.execute();

		await migration.up(ctx.db);

		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select([
				"collection_id",
				"status",
				"completed_at",
				"reconciliation_required",
				"capture_state",
			])
			.where("scope_key", "=", "posts")
			.executeTakeFirstOrThrow();
		expect(status).toEqual({
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-01T12:00:00.000Z",
			reconciliation_required: 1,
			capture_state: "installing",
		});

		const unmatched = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("scope_key")
			.where("scope_key", "=", "deleted_collection")
			.executeTakeFirst();
		expect(unmatched).toBeUndefined();

		const source = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select(["collection_id", "identity_version", "source_fingerprint", "content_title"])
			.where("source_key", "=", "content:posts:entry-1:columns")
			.executeTakeFirstOrThrow();
		expect(source).toEqual({
			collection_id: null,
			identity_version: null,
			source_fingerprint: "legacy-fingerprint",
			content_title: "Legacy title",
		});
		const occurrence = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["source_key", "generation", "reference_type", "media_id", "provider_asset_id"])
			.where("id", "=", "usage-1")
			.executeTakeFirstOrThrow();
		expect(occurrence).toEqual({
			source_key: "content:posts:entry-1:columns",
			generation: "generation-1",
			reference_type: "local",
			media_id: "media-1",
			provider_asset_id: "media-1",
		});
		expect(
			await ctx.db.selectFrom("_emdash_media_usage_work").select("content_id").execute(),
		).toEqual([]);

		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ collection_cursor: "posts", attempt_count: 2 })
			.execute();
		await migration.up(ctx.db);

		const activation = await ctx.db
			.selectFrom("_emdash_media_usage_activation")
			.select(["state", "collection_cursor", "attempt_count"])
			.executeTakeFirstOrThrow();
		expect(activation).toEqual({
			state: "expanded",
			collection_cursor: "posts",
			attempt_count: 2,
		});
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("id", "=", "usage-1")
				.executeTakeFirst(),
		).toEqual({ id: "usage-1" });
	});

	it("purges a partially bound status if its collection is deleted or recreated before retry", async () => {
		const reconciliationMigration =
			await import("../../../src/database/migrations/066_media_usage_reconciliation.js");
		await reconciliationMigration.down(ctx.db);
		const collectionDeletionMigration =
			await import("../../../src/database/migrations/065_media_usage_collection_deletion.js");
		await collectionDeletionMigration.down(ctx.db);
		const migration =
			await import("../../../src/database/migrations/063_media_usage_incremental_work.js");
		await migration.down(ctx.db);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "recreated", label: "Recreated" });
		await registry.createCollection({ slug: "deleted", label: "Deleted" });
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values([
				{
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "recreated",
					status: "never",
				},
				{
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "deleted",
					status: "never",
				},
			])
			.execute();
		await migration.up(ctx.db);

		await ctx.db
			.updateTable("_emdash_collections")
			.set({ id: "replacement-collection-id" })
			.where("slug", "=", "recreated")
			.execute();
		await ctx.db.deleteFrom("_emdash_collections").where("slug", "=", "deleted").execute();
		await migration.up(ctx.db);

		const statuses = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("scope_key")
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "in", ["recreated", "deleted"])
			.execute();
		expect(statuses).toEqual([]);
	});
});
