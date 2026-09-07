import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { tableExists } from "../../../src/database/dialect-helpers.js";
import {
	MediaUsageCollectionDeletionRepository,
	executeLocalCollectionDeletionGuard,
} from "../../../src/media/usage/collection-deletion.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage collection deletion foundation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("fences and drops only for the exact live tombstone lease", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "articles", label: "Articles" });
		const collection = await registry.getCollection("articles");
		if (!collection) throw new Error("Expected articles collection");

		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: collection.slug,
				collection_id: collection.id,
				status: "complete",
				capture_state: "active",
			})
			.execute();

		const repository = new MediaUsageCollectionDeletionRepository(ctx.db);
		await repository.createTombstone({
			collectionId: collection.id,
			collectionSlug: collection.slug,
			forceDelete: false,
		});
		const claim = await repository.claim({
			collectionId: collection.id,
			phase: "fence",
			leaseDurationSeconds: 300,
		});
		expect(claim).not.toBeNull();

		const staleFence = await executeLocalCollectionDeletionGuard(ctx.db, {
			action: "fence",
			collectionId: collection.id,
			collectionSlug: collection.slug,
			leaseToken: "stale-token",
			forceDelete: false,
		});
		expect(staleFence).toEqual({ outcome: "stale" });
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("capture_state")
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ capture_state: "active" });

		await expect(
			executeLocalCollectionDeletionGuard(ctx.db, {
				action: "fence",
				collectionId: collection.id,
				collectionSlug: collection.slug,
				leaseToken: claim!.leaseToken,
				forceDelete: false,
			}),
		).resolves.toEqual({ outcome: "fenced" });

		await ctx.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({ phase: "table" })
			.where("collection_id", "=", collection.id)
			.execute();
		await expect(
			executeLocalCollectionDeletionGuard(ctx.db, {
				action: "drop",
				collectionId: collection.id,
				collectionSlug: collection.slug,
				leaseToken: claim!.leaseToken,
			}),
		).resolves.toEqual({ outcome: "dropped" });
		expect(await tableExists(ctx.db, "ec_articles")).toBe(false);
	});

	it("does not let an expired owner drop a replacement table", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "reused", label: "Reused" });
		const collection = await registry.getCollection("reused");
		if (!collection) throw new Error("Expected reused collection");

		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collection.id,
				collection_slug: collection.slug,
				force_delete: 1,
				state: "leased",
				phase: "table",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: "old-owner",
				lease_expires_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(
			executeLocalCollectionDeletionGuard(ctx.db, {
				action: "drop",
				collectionId: collection.id,
				collectionSlug: collection.slug,
				leaseToken: "old-owner",
			}),
		).resolves.toEqual({ outcome: "stale" });
		expect(await tableExists(ctx.db, "ec_reused")).toBe(true);
	});

	it("keeps a non-empty collection unchanged when force is false", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "occupied", label: "Occupied" });
		const collection = await registry.getCollection("occupied");
		if (!collection) throw new Error("Expected occupied collection");
		await sql`INSERT INTO ${sql.ref("ec_occupied")} (id, slug) VALUES ('entry-1', 'entry-1')`.execute(
			ctx.db,
		);
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: collection.slug,
				collection_id: collection.id,
				status: "complete",
				capture_state: "active",
			})
			.execute();

		const repository = new MediaUsageCollectionDeletionRepository(ctx.db);
		await repository.createTombstone({
			collectionId: collection.id,
			collectionSlug: collection.slug,
			forceDelete: false,
		});
		const claim = await repository.claim({
			collectionId: collection.id,
			phase: "fence",
			leaseDurationSeconds: 300,
		});
		if (!claim) throw new Error("Expected deletion claim");

		await expect(
			executeLocalCollectionDeletionGuard(ctx.db, {
				action: "fence",
				collectionId: collection.id,
				collectionSlug: collection.slug,
				leaseToken: claim.leaseToken,
				forceDelete: false,
			}),
		).resolves.toEqual({ outcome: "has_content" });
		expect(await tableExists(ctx.db, "ec_occupied")).toBe(true);
	});
});
