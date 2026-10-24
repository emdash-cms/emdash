import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { activateMediaUsageCapture } from "../../src/media/usage/activation.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

vi.mock("virtual:emdash/dialect", () => ({
	executeCollectionDeletionGuard: (
		_config: unknown,
		input: Parameters<typeof executeCollectionDeletionGuard>[1],
	) => executeCollectionDeletionGuard({ binding: "DB" }, input),
}));

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

it("removes the records its entries held in shared tables when media usage capture is inactive", async () => {
	const collectionSlug = "cleanup_inactive";
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: collectionSlug, label: "Cleanup inactive" });
	await seedSharedRecords(collectionSlug);

	await registry.deleteCollection(collectionSlug, { force: true });

	await expectSharedTableCounts(collectionSlug, {
		revisions: 0,
		seo: 0,
		comments: 0,
		contentBylines: 0,
		contentTaxonomies: 0,
		entryLocks: 0,
		revisionPruneQueue: 0,
	});
});

it("removes shared-table records once media usage capture is active", async () => {
	await activateMediaUsageCapture(db, { writersDrained: true });
	const collectionSlug = "cleanup_active";
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: collectionSlug, label: "Cleanup active" });
	await seedSharedRecords(collectionSlug);

	await registry.deleteCollection(collectionSlug, { force: true });

	await expectSharedTableCounts(collectionSlug, {
		revisions: 0,
		seo: 0,
		comments: 0,
		contentBylines: 0,
		contentTaxonomies: 0,
		entryLocks: 0,
		revisionPruneQueue: 0,
	});
});

async function seedSharedRecords(collectionSlug: string): Promise<string> {
	const entryId = `${collectionSlug}-entry-1`;
	const revisionId = `${entryId}-revision-1`;
	const bylineId = `${entryId}-byline-1`;
	const taxonomyId = `${entryId}-taxonomy-1`;

	await db
		.insertInto("revisions")
		.values({ id: revisionId, collection: collectionSlug, entry_id: entryId, data: "{}" })
		.execute();

	const tableName = `ec_${collectionSlug}`;
	await sql`
		INSERT INTO ${sql.ref(tableName)} (id, slug, translation_group, live_revision_id, draft_revision_id)
		VALUES (${entryId}, ${entryId}, ${entryId}, ${revisionId}, ${revisionId})
	`.execute(db);

	await db
		.insertInto("_emdash_seo")
		.values({ collection: collectionSlug, content_id: entryId, seo_title: "Title" })
		.execute();

	await db
		.insertInto("_emdash_revision_prune_queue")
		.values({ collection: collectionSlug, entry_id: entryId, revision_id: revisionId })
		.execute();

	await db
		.insertInto("users")
		.values({ id: `${entryId}-user-1`, email: `${entryId}-user-1@example.com`, role: 10 })
		.execute();

	await db
		.insertInto("_emdash_entry_locks")
		.values({
			collection: collectionSlug,
			entry_id: entryId,
			user_id: `${entryId}-user-1`,
			token: `${entryId}-token-1`,
			acquired_at: new Date().toISOString(),
			expires_at: new Date().toISOString(),
		})
		.execute();

	await db
		.insertInto("_emdash_comments")
		.values({
			id: `${entryId}-comment-1`,
			collection: collectionSlug,
			content_id: entryId,
			author_name: "Author",
			author_email: "author@example.com",
			body: "Comment body",
			status: "approved",
		})
		.execute();

	await db
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
	await db
		.insertInto("_emdash_content_bylines")
		.values({
			id: `${entryId}-content-byline-1`,
			collection_slug: collectionSlug,
			content_id: entryId,
			byline_id: bylineId,
			sort_order: 0,
		})
		.execute();

	await db
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
	await db
		.insertInto("content_taxonomies")
		.values({
			collection: collectionSlug,
			entry_id: entryId,
			taxonomy_id: taxonomyId,
		})
		.execute();

	return entryId;
}

async function expectSharedTableCounts(
	collectionSlug: string,
	expected: {
		revisions: number;
		seo: number;
		comments: number;
		contentBylines: number;
		contentTaxonomies: number;
		entryLocks: number;
		revisionPruneQueue: number;
	},
): Promise<void> {
	const counts = {
		revisions: await count(db.selectFrom("revisions").where("collection", "=", collectionSlug)),
		seo: await count(db.selectFrom("_emdash_seo").where("collection", "=", collectionSlug)),
		comments: await count(
			db.selectFrom("_emdash_comments").where("collection", "=", collectionSlug),
		),
		contentBylines: await count(
			db.selectFrom("_emdash_content_bylines").where("collection_slug", "=", collectionSlug),
		),
		contentTaxonomies: await count(
			db.selectFrom("content_taxonomies").where("collection", "=", collectionSlug),
		),
		entryLocks: await count(
			db.selectFrom("_emdash_entry_locks").where("collection", "=", collectionSlug),
		),
		revisionPruneQueue: await count(
			db.selectFrom("_emdash_revision_prune_queue").where("collection", "=", collectionSlug),
		),
	};
	expect(counts).toEqual(expected);
}

async function count(
	query: import("kysely").SelectQueryBuilder<Database, never, unknown>,
): Promise<number> {
	const result = await query.select((eb) => eb.fn.countAll().as("count")).executeTakeFirst();
	return Number(result?.count ?? 0);
}
