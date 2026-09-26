import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { isPostgres } from "../../../../src/database/dialect-helpers.js";
import type { Database } from "../../../../src/database/types.js";
import type { SitePackageRecord } from "../../../../src/transfer/format/kinds.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { fixtureId } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../../utils/transfer/origin-site.js";
import { packageRecords, runExport } from "./helpers.js";

type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

const T = "2026-04-01T00:00:00.000Z";
const GONE = fixtureId(9999);

/**
 * Run `insert` with foreign key enforcement off on one connection, so the
 * database can hold the orphans an installation without enforced foreign
 * keys (or with keys lost in a table rebuild) can hold.
 */
async function withoutForeignKeys(
	db: Kysely<Database>,
	insert: (db: AnyDb) => Promise<void>,
): Promise<void> {
	await db.connection().execute(async (connection) => {
		const raw = connection as unknown as AnyDb;
		if (isPostgres(db)) await sql`SET session_replication_role = replica`.execute(connection);
		else await sql`PRAGMA foreign_keys = OFF`.execute(connection);
		try {
			await insert(raw);
		} finally {
			if (isPostgres(db)) await sql`SET session_replication_role = DEFAULT`.execute(connection);
			else await sql`PRAGMA foreign_keys = ON`.execute(connection);
		}
	});
}

/** One orphan of every kind a real database can hold; returns the ids that must be left out. */
async function insertOrphans(db: Kysely<Database>, site: OriginSite): Promise<string[]> {
	const ids = site.ids;
	const pending = site.media.find((item) => item.id === ids.pendingMedia)!;
	const dropped = [
		fixtureId(9001),
		fixtureId(9002),
		fixtureId(9003),
		fixtureId(9004),
		fixtureId(9005),
		fixtureId(9006),
		fixtureId(9007),
		fixtureId(9008),
		fixtureId(9009),
		fixtureId(9010),
		fixtureId(9011),
		fixtureId(9012),
		fixtureId(9013),
	];
	await withoutForeignKeys(db, async (raw) => {
		await raw
			.insertInto("_emdash_fields")
			.values({
				id: fixtureId(9001),
				collection_id: GONE,
				slug: "ghost_field",
				label: "Ghost",
				type: "string",
				column_type: "TEXT",
			})
			.execute();
		await raw
			.insertInto("_emdash_relations")
			.values({
				id: fixtureId(9002),
				slug: "ghost_relation",
				parent_collection: "ghosts",
				child_collection: "pages",
				parent_label: "Ghost",
				child_label: "Ghost",
			})
			.execute();
		await raw
			.insertInto("_emdash_content_references")
			.values({
				id: fixtureId(9014),
				relation_id: fixtureId(9002),
				parent_group: ids.hello,
				child_group: ids.about,
				sort_order: 0,
			})
			.execute();
		await raw
			.insertInto("taxonomies")
			.values([
				{
					id: fixtureId(9003),
					name: "category",
					slug: "lost",
					label: "Lost",
					parent_id: GONE,
					locale: "en",
					translation_group: fixtureId(9003),
				},
				{
					id: fixtureId(9004),
					name: "category",
					slug: "lost-child",
					label: "Lost child",
					parent_id: fixtureId(9003),
					locale: "en",
					translation_group: fixtureId(9004),
				},
			])
			.execute();
		await raw
			.insertInto("_emdash_byline_field_values")
			.values({ byline_id: GONE, field_id: fixtureId(1121), value: JSON.stringify("x") })
			.execute();
		await raw
			.insertInto("_emdash_byline_field_group_values")
			.values({ translation_group: ids.aliceEn, field_id: GONE, value: JSON.stringify("x") })
			.execute();
		await raw
			.insertInto("revisions")
			.values({
				id: fixtureId(9005),
				collection: "posts",
				entry_id: GONE,
				data: JSON.stringify({ title: "Deleted" }),
				author_id: ids.carol,
				created_at: T,
			})
			.execute();
		await raw
			.insertInto("ec_posts")
			.values({
				id: fixtureId(9020),
				slug: "pointers",
				status: "draft",
				version: 1,
				locale: "en",
				translation_group: fixtureId(9020),
				title: "Dangling pointers",
				live_revision_id: GONE,
				draft_revision_id: fixtureId(9005),
				primary_byline_id: GONE,
				featured_image: JSON.stringify({
					id: ids.pendingMedia,
					provider: "local",
					meta: { storageKey: pending.storageKey },
				}),
				created_at: T,
				updated_at: T,
			})
			.execute();
		await raw
			.insertInto("_emdash_content_bylines")
			.values([
				{
					id: fixtureId(9006),
					collection_slug: "posts",
					content_id: GONE,
					byline_id: ids.aliceEn,
					sort_order: 0,
				},
				{
					id: fixtureId(9007),
					collection_slug: "posts",
					content_id: ids.hello,
					byline_id: GONE,
					sort_order: 5,
				},
			])
			.execute();
		await raw
			.insertInto("_emdash_seo")
			.values({
				collection: "pages",
				content_id: GONE,
				seo_title: "Ghost",
				seo_no_index: 0,
				created_at: T,
				updated_at: T,
			})
			.execute();
		await raw
			.insertInto("_emdash_menu_items")
			.values([
				{
					id: fixtureId(9008),
					menu_id: GONE,
					sort_order: 0,
					type: "custom",
					custom_url: "/",
					label: "Lost",
					locale: "en",
					translation_group: fixtureId(9008),
				},
				{
					id: fixtureId(9009),
					menu_id: GONE,
					parent_id: fixtureId(9008),
					sort_order: 0,
					type: "custom",
					custom_url: "/",
					label: "Lost child",
					locale: "en",
					translation_group: fixtureId(9009),
				},
			])
			.execute();
		await raw
			.insertInto("_emdash_widgets")
			.values({ id: fixtureId(9010), area_id: GONE, sort_order: 0, type: "content" })
			.execute();
		await raw
			.insertInto("_emdash_comments")
			.values([
				{
					id: fixtureId(9011),
					collection: "posts",
					content_id: GONE,
					author_name: "Ghost",
					author_email: "ghost@example.net",
					author_user_id: ids.carol,
					body: "Orphaned",
					status: "approved",
					created_at: T,
					updated_at: T,
				},
				{
					id: fixtureId(9012),
					collection: "posts",
					content_id: ids.hello,
					parent_id: fixtureId(9011),
					author_name: "Ghost",
					author_email: "ghost@example.net",
					body: "Reply to an orphan",
					status: "approved",
					created_at: T,
					updated_at: T,
				},
			])
			.execute();
		await raw
			.insertInto("_emdash_comment_reactions")
			.values([
				{
					id: fixtureId(9013),
					comment_id: fixtureId(9012),
					reaction: "like",
					voter_hash: "v1",
					created_at: T,
				},
				{
					id: fixtureId(9015),
					comment_id: GONE,
					reaction: "like",
					voter_hash: "v2",
					created_at: T,
				},
			])
			.execute();
		await raw
			.updateTable("media")
			.set({ folder_id: GONE })
			.where("id", "=", ids.inlineMedia)
			.execute();
		await raw
			.updateTable("_emdash_bylines")
			.set({ avatar_media_id: GONE })
			.where("id", "=", ids.guest)
			.execute();
		await raw
			.updateTable("_emdash_sections")
			.set({ preview_media_id: GONE })
			.where("id", "=", fixtureId(1330))
			.execute();
		await raw
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["posts", "ghosts"]) })
			.where("id", "=", fixtureId(1100))
			.execute();
		await raw
			.insertInto("_emdash_widgets")
			.values({
				id: fixtureId(9016),
				area_id: fixtureId(1320),
				sort_order: 9,
				type: "menu",
				menu_name: "ghost-menu",
			})
			.execute();
	});
	return [...dropped, fixtureId(9014), fixtureId(9015), fixtureId(9016)];
}

describeEachDialect("site export of a database with orphans", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let site: OriginSite;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		site = await buildOriginSite(ctx.db, storage);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("leaves every orphan out, declares it, and produces a package the validator accepts", async () => {
		const droppedIds = await insertOrphans(ctx.db, site);

		for (const budget of [undefined, () => new TransferStepBudget({ bytes: 1 })]) {
			const run = await runExport(ctx.db, storage, { budget });
			expect(run.result.operation.errorDetail).toBeNull();
			expect(run.result.outcome).toBe("complete");
			expect(run.validation?.done).toBe(true);
			expect(run.validation?.blockers).toEqual([]);

			const records = await packageRecords(run.reader);
			const all = [...records.values()].flat();
			const present = new Set(all.map((record) => record.id));
			for (const id of droppedIds) expect(present.has(id), id).toBe(false);
			expect(present.has(`pages:${GONE}`)).toBe(false);
			expect(present.has(`${GONE}:${fixtureId(1121)}`)).toBe(false);
			expect(present.has(`${site.ids.aliceEn}:${GONE}`)).toBe(false);
			expect(JSON.stringify(all)).not.toContain(GONE);
			// Carol is referenced only by dropped rows, so she is not a principal.
			expect(present.has(site.ids.carol)).toBe(false);
			expect(JSON.stringify(all)).not.toContain(`emdash-media:${site.ids.pendingMedia}`);

			const byId = new Map<string, SitePackageRecord>(all.map((r) => [`${r.kind}:${r.id}`, r]));
			const pointers = byId.get(`entry:${fixtureId(9020)}`);
			expect(pointers).toMatchObject({ kind: "entry", fields: { title: "Dangling pointers" } });
			expect(pointers && "liveRevisionId" in pointers).toBe(false);
			expect(pointers && "draftRevisionId" in pointers).toBe(false);
			expect(pointers && "primaryBylineGroup" in pointers).toBe(false);
			expect(byId.get(`taxonomy_def:${fixtureId(1100)}`)).toMatchObject({ collections: ["posts"] });
			expect(byId.has(`comment:${site.ids.rootComment}`)).toBe(true);

			const transformations = Object.fromEntries(
				(await run.reader.manifest()).transformations.map((t) => [`${t.code}:${t.kind}`, t.count]),
			);
			expect(transformations).toMatchObject({
				"orphan_dropped:field": 1,
				"orphan_dropped:relation": 1,
				"orphan_dropped:term": 2,
				"orphan_dropped:byline_field_value": 1,
				"orphan_dropped:byline_field_group_value": 1,
				"orphan_dropped:revision": 1,
				"orphan_dropped:content_byline": 2,
				"orphan_dropped:seo": 1,
				"orphan_dropped:comment": 2,
				"orphan_dropped:comment_reaction": 2,
				"soft_orphan_dropped:menu_item": 2,
				"soft_orphan_dropped:widget": 2,
				"soft_orphan_dropped:content_reference": 1,
				"soft_orphan_dropped:taxonomy_def": 1,
				"orphan_reference_nulled:entry": 3,
				"orphan_reference_nulled:media": 1,
				"avatar_nulled:byline": 1,
				"avatar_nulled:section": 1,
				"media_ref_unlinked:entry": 1,
			});
		}
	}, 60_000);
});
