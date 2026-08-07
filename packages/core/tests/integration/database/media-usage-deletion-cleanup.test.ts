import { sql, type RawBuilder } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	MEDIA_USAGE_DELETION_CLEANUP_LIMITS,
	processDueMediaUsageDeletionCleanup,
} from "../../../src/media/usage/deletion-cleanup.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage deletion cleanup", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("removes one deleted collection's bound index data in bounded resumable batches", async () => {
		const fixture = await createDeletingFixture("retired");
		await seedWork(fixture.collectionId, fixture.slug, 23);
		await seedSource(fixture.collectionId, fixture.slug, "source-a", 13);
		await seedSource(fixture.collectionId, fixture.slug, "source-b", 13);
		await seedSource(null, fixture.slug, "legacy-unbound", 1);
		await seedSource("other-collection", "other", "other-source", 1);

		const results = [];
		for (let tick = 0; tick < 20; tick++) {
			const result = await processDueMediaUsageDeletionCleanup(ctx.db);
			results.push(result);
			if (result.outcome === "complete") break;
		}

		expect(results.at(-1)?.outcome).toBe("complete");
		expect(results.every((result) => result.rowsDeleted <= 10)).toBe(true);
		expect(
			results.some(
				(result) => result.rowsDeleted === MEDIA_USAGE_DELETION_CLEANUP_LIMITS.workRowsPerBatch,
			),
		).toBe(true);
		expect(
			results.some(
				(result) =>
					result.rowsDeleted === MEDIA_USAGE_DELETION_CLEANUP_LIMITS.occurrenceRowsPerBatch,
			),
		).toBe(true);
		expect(await count("_emdash_media_usage_work", "collection_id", fixture.collectionId)).toBe(0);
		expect(await count("_emdash_media_usage_sources", "collection_id", fixture.collectionId)).toBe(
			0,
		);
		expect(await sourceExists("source-a")).toBe(false);
		expect(await sourceExists("source-b")).toBe(false);
		expect(await sourceExists("legacy-unbound")).toBe(true);
		expect(await sourceExists("other-source")).toBe(true);
		expect(await occurrenceCount("legacy-unbound")).toBe(1);
		expect(await occurrenceCount("other-source")).toBe(1);
		expect(await cleanupRow(fixture.collectionId)).toBeUndefined();
	});

	it("does not steal a live lease and resumes an expired lease", async () => {
		const fixture = await createDeletingFixture("leased");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				cleanup_state: "leased",
				cleanup_lease_token: "current-owner",
				cleanup_lease_expires_at: "2100-01-01T00:00:00.000Z",
			})
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		expect(await processDueMediaUsageDeletionCleanup(ctx.db)).toEqual(
			expect.objectContaining({ outcome: "idle", claimed: false }),
		);
		expect(await cleanupRow(fixture.collectionId)).toEqual(
			expect.objectContaining({ cleanup_lease_token: "current-owner", cleanup_phase: "work" }),
		);

		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ cleanup_lease_expires_at: "2000-01-01T00:00:00.000Z" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		expect(await processDueMediaUsageDeletionCleanup(ctx.db)).toEqual(
			expect.objectContaining({ outcome: "progress", claimed: true, phase: "work" }),
		);
		expect(await cleanupRow(fixture.collectionId)).toEqual(
			expect.objectContaining({
				cleanup_state: "pending",
				cleanup_phase: "sources",
				cleanup_lease_token: null,
			}),
		);
	});

	it("finishes draining a source whose row disappears between occurrence batches", async () => {
		const fixture = await createDeletingFixture("interrupted_source");
		await seedSource(fixture.collectionId, fixture.slug, "source-a", 13);
		await seedSource(fixture.collectionId, fixture.slug, "source-b", 1);

		await processDueMediaUsageDeletionCleanup(ctx.db);
		const firstSourceBatch = await processDueMediaUsageDeletionCleanup(ctx.db);
		expect(firstSourceBatch).toEqual(
			expect.objectContaining({
				outcome: "progress",
				phase: "sources",
				rowsDeleted: MEDIA_USAGE_DELETION_CLEANUP_LIMITS.occurrenceRowsPerBatch,
			}),
		);
		await ctx.db
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_key", "=", "source-a")
			.execute();

		for (let tick = 0; tick < 10; tick++) {
			if ((await processDueMediaUsageDeletionCleanup(ctx.db)).outcome === "complete") break;
		}

		expect(await occurrenceCount("source-a")).toBe(0);
		expect(await sourceExists("source-b")).toBe(false);
		expect(await cleanupRow(fixture.collectionId)).toBeUndefined();
	});

	it("cannot checkpoint after another cleaner takes over its exact lease", async () => {
		if (dialect !== "sqlite") return;
		const fixture = await createDeletingFixture("takeover");
		await sql`
			CREATE TRIGGER steal_media_usage_deletion_cleanup_lease
			AFTER UPDATE OF cleanup_state ON _emdash_media_usage_index_status
			WHEN NEW.cleanup_state = 'leased' AND NEW.cleanup_lease_token <> 'new-owner'
			BEGIN
				UPDATE _emdash_media_usage_index_status
				SET cleanup_lease_token = 'new-owner',
					cleanup_lease_expires_at = '2100-01-01T00:00:00.000Z'
				WHERE collection_id = NEW.collection_id;
			END
		`.execute(ctx.db);

		expect(await processDueMediaUsageDeletionCleanup(ctx.db)).toEqual(
			expect.objectContaining({ outcome: "conflict", claimed: true, rowsDeleted: 0 }),
		);
		expect(await cleanupRow(fixture.collectionId)).toEqual(
			expect.objectContaining({
				cleanup_state: "leased",
				cleanup_phase: "work",
				cleanup_lease_token: "new-owner",
			}),
		);
	});

	it("fails terminally without touching a replacement that reuses the slug", async () => {
		const fixture = await createDeletingFixture("replacement");
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: fixture.slug, label: "Replacement" });
		const replacement = await registry.getCollection(fixture.slug);
		if (!replacement) throw new Error("Expected replacement collection");

		for (let attempt = 1; attempt <= MEDIA_USAGE_DELETION_CLEANUP_LIMITS.maxAttempts; attempt++) {
			await ctx.db
				.updateTable("_emdash_media_usage_index_status")
				.set({ cleanup_next_attempt_at: "2000-01-01T00:00:00.000Z" })
				.where("collection_id", "=", fixture.collectionId)
				.execute();
			const result = await processDueMediaUsageDeletionCleanup(ctx.db);
			expect(result.outcome).toBe(
				attempt === MEDIA_USAGE_DELETION_CLEANUP_LIMITS.maxAttempts ? "failed" : "retry",
			);
		}

		expect(await cleanupRow(fixture.collectionId)).toEqual(
			expect.objectContaining({
				cleanup_state: "failed",
				cleanup_attempt_count: MEDIA_USAGE_DELETION_CLEANUP_LIMITS.maxAttempts,
				cleanup_last_error_code: "MEDIA_USAGE_DELETION_NOT_READY",
			}),
		);
		expect(await registry.getCollection(fixture.slug)).toEqual(
			expect.objectContaining({ id: replacement.id }),
		);
		await expect(
			sql`SELECT id FROM ${sql.ref(`ec_${fixture.slug}`)} LIMIT 1`.execute(ctx.db),
		).resolves.toBeDefined();
	});

	it("uses bounded SQLite indexes for every cleanup cursor", async () => {
		if (dialect !== "sqlite") return;
		const duePlan = await explain(sql`
			SELECT collection_id
			FROM _emdash_media_usage_index_status
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND capture_state = 'deleting'
				AND cleanup_state = 'pending'
				AND cleanup_next_attempt_at <= '2026-08-07T00:00:00.000Z'
			ORDER BY cleanup_next_attempt_at, updated_at, collection_id
			LIMIT 4
		`);
		const leasePlan = await explain(sql`
			SELECT collection_id
			FROM _emdash_media_usage_index_status
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND capture_state = 'deleting'
				AND cleanup_state = 'leased'
				AND cleanup_lease_expires_at <= '2026-08-07T00:00:00.000Z'
			ORDER BY cleanup_lease_expires_at, updated_at, collection_id
			LIMIT 4
		`);
		const sourcePlan = await explain(sql`
			SELECT source_key
			FROM _emdash_media_usage_sources
			WHERE source_type = 'content'
				AND collection_id = 'collection-id'
				AND source_key > 'cursor'
			ORDER BY source_key
			LIMIT 1
		`);
		const occurrencePlan = await explain(sql`
			SELECT id
			FROM _emdash_media_usage
			WHERE source_key = 'source-key' AND id > 'cursor'
			ORDER BY id
			LIMIT 10
		`);

		expect(duePlan).toContain("idx__emdash_media_usage_status_cleanup_due");
		expect(leasePlan).toContain("idx__emdash_media_usage_status_cleanup_lease");
		expect(sourcePlan).toContain("idx__emdash_media_usage_sources_cleanup");
		expect(occurrencePlan).toContain("idx__emdash_media_usage_occurrences_cleanup");
		expect(`${duePlan}\n${leasePlan}\n${sourcePlan}\n${occurrencePlan}`).not.toContain(
			"USE TEMP B-TREE",
		);
	});

	async function createDeletingFixture(slug: string) {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug, label: slug });
		const collection = await registry.getCollection(slug);
		if (!collection) throw new Error(`Expected ${slug} collection`);
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: slug,
				status: "stale",
				collection_id: collection.id,
				reconciliation_required: 1,
				capture_state: "deleting",
				cleanup_state: "pending",
				cleanup_phase: "work",
				cleanup_next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		await sql`DROP TABLE ${sql.ref(`ec_${slug}`)}`.execute(ctx.db);
		await ctx.db.deleteFrom("_emdash_collections").where("id", "=", collection.id).execute();
		return { collectionId: collection.id, slug };
	}

	async function seedWork(collectionId: string, collectionSlug: string, amount: number) {
		for (let index = 0; index < amount; index++) {
			await ctx.db
				.insertInto("_emdash_media_usage_work")
				.values({
					collection_id: collectionId,
					collection_slug: collectionSlug,
					content_id: `entry-${String(index).padStart(3, "0")}`,
					change_epoch: 1,
					next_attempt_at: "2000-01-01T00:00:00.000Z",
				})
				.execute();
		}
	}

	async function seedSource(
		collectionId: string | null,
		collectionSlug: string,
		sourceKey: string,
		occurrences: number,
	) {
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection_id: collectionId,
				collection_slug: collectionSlug,
				content_id: "entry",
				source_variant: "columns",
				current_generation: "generation",
			})
			.execute();
		for (let index = 0; index < occurrences; index++) {
			await ctx.db
				.insertInto("_emdash_media_usage")
				.values({
					id: `${sourceKey}-occurrence-${String(index).padStart(3, "0")}`,
					source_key: sourceKey,
					generation: "generation",
					field_slug: "image",
					field_path: `image.${index}`,
					occurrence_index: index,
					reference_type: "media_field",
					media_id: null,
					provider: "remote",
					provider_asset_id: `${sourceKey}-${index}`,
				})
				.execute();
		}
	}

	async function cleanupRow(collectionId: string) {
		return ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.executeTakeFirst();
	}

	async function count(
		table: "_emdash_media_usage_work" | "_emdash_media_usage_sources",
		column: "collection_id",
		value: string,
	) {
		const row = await ctx.db
			.selectFrom(table)
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where(column, "=", value)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function sourceExists(sourceKey: string) {
		return (
			(await ctx.db
				.selectFrom("_emdash_media_usage_sources")
				.select("source_key")
				.where("source_key", "=", sourceKey)
				.executeTakeFirst()) !== undefined
		);
	}

	async function occurrenceCount(sourceKey: string) {
		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "=", sourceKey)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function explain(query: RawBuilder<unknown>) {
		const compiled = query.compile(ctx.db);
		const result = await ctx.db.executeQuery<{ detail: string }>({
			...compiled,
			sql: `EXPLAIN QUERY PLAN ${compiled.sql}`,
		});
		return result.rows.map((row) => row.detail).join("\n");
	}
});
