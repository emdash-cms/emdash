import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up } from "../../../src/database/migrations/092_media_usage_file_url_reindex.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { runMediaUsageMaintenanceStep } from "../../../src/media/usage/maintenance-engine.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("092_media_usage_file_url_reindex migration", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reindexes a tracked site so images named by file URL show where they are used", async () => {
		const image = await new MediaRepository(db).create({
			filename: "slash-menu.png",
			mimeType: "image/png",
			storageKey: "01K0SLASHMENU.png",
		});
		await sql`
			INSERT INTO ec_posts (id, slug, status, title, body)
			VALUES (
				'post-1',
				'release-notes',
				'published',
				'Release notes',
				${JSON.stringify([
					{
						_type: "image",
						_key: "a",
						asset: { url: "/_emdash/api/media/file/01K0SLASHMENU.png" },
					},
				])}
			)
		`.execute(db);
		await markTrackedAndComplete(db, "posts");
		const usage = new MediaUsageRepository(db);
		expect(await usage.findCurrentUsageByMediaId(image.id)).toEqual([]);

		await up(db);
		for (let step = 0; step < 50; step++) {
			const result = await runMediaUsageMaintenanceStep(db);
			if (result.state === "idle") break;
		}

		expect(await usage.findCurrentUsageByMediaId(image.id)).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ contentId: "post-1", contentTitle: "Release notes" }),
			}),
		]);
		expect(await indexStatus(db, "posts")).toEqual({
			status: "complete",
			reconciliation_required: 0,
		});
	});

	it("leaves tracked collections without rich text alone", async () => {
		await markTrackedAndComplete(db, "posts");
		await new SchemaRegistry(db).createCollection({ slug: "photos", label: "Photos" });
		await new SchemaRegistry(db).createField("photos", {
			slug: "image",
			label: "Image",
			type: "image",
		});
		await db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				reconciliation_required: 0,
			})
			.where("scope_key", "=", "photos")
			.execute();
		const before = await indexStatus(db, "photos");

		await up(db);

		expect(await indexStatus(db, "photos")).toEqual(before);
		expect(await indexStatus(db, "posts")).toEqual(
			expect.objectContaining({ reconciliation_required: 1 }),
		);
	});

	it("leaves sites that never turned tracking on alone", async () => {
		const posts = await db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("slug", "=", "posts")
			.executeTakeFirstOrThrow();
		await db
			.updateTable("_emdash_media_usage_index_status")
			.set({ collection_id: posts.id, status: "complete", capture_state: "active" })
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.execute();
		const before = await db.selectFrom("_emdash_media_usage_index_status").selectAll().execute();

		await up(db);

		expect(await db.selectFrom("_emdash_media_usage_index_status").selectAll().execute()).toEqual(
			before,
		);
	});
});

async function markTrackedAndComplete(db: Kysely<Database>, collectionSlug: string): Promise<void> {
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirstOrThrow();
	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-01T00:00:00.000Z",
			reconciliation_required: 0,
			capture_state: "installing",
		})
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collectionSlug)
		.execute();
	await installMediaUsageCaptureTriggers(db, { collectionId: collection.id, collectionSlug });
	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();
}

async function indexStatus(db: Kysely<Database>, collectionSlug: string) {
	return db
		.selectFrom("_emdash_media_usage_index_status")
		.select(["status", "reconciliation_required"])
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collectionSlug)
		.executeTakeFirst();
}
