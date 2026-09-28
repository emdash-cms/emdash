import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as BetterSqlite3 } from "#node-sqlite";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { tableExists } from "../../../src/database/dialect-helpers.js";
import { kyselyLogOption } from "../../../src/database/instrumentation.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { removeMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { MediaUsageCollectionDeletionRepository } from "../../../src/media/usage/collection-deletion.js";
import { MEDIA_USAGE_MAINTENANCE_LIMITS } from "../../../src/media/usage/maintenance-engine.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage activated collection deletion", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("detaches an empty activated collection and leaves bounded cleanup pending", async () => {
		const collection = await registry.createCollection({ slug: "articles", label: "Articles" });

		await registry.deleteCollection("articles");

		expect(await registry.getCollection("articles")).toBeNull();
		expect(await tableExists(ctx.db, "ec_articles")).toBe(false);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["collection_id", "capture_state"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toEqual({ collection_id: collection.id, capture_state: "deleting" });
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select(["collection_id", "collection_slug", "state", "phase", "lease_token"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toEqual({
			collection_id: collection.id,
			collection_slug: "articles",
			state: "pending",
			phase: "work",
			lease_token: null,
		});
	});

	it("preserves the collection-not-found contract after activation", async () => {
		await expect(registry.deleteCollection("missing")).rejects.toMatchObject({
			code: "COLLECTION_NOT_FOUND",
		});
	});

	it("reports a live front-phase lease as a stable conflict", async () => {
		const collection = await registry.createCollection({ slug: "leased", label: "Leased" });
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collection.id,
				collection_slug: collection.slug,
				force_delete: 1,
				state: "leased",
				phase: "fence",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: "live-owner",
				lease_expires_at: "2999-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(registry.deleteCollection("leased", { force: true })).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("does not fence or detach a non-empty collection without force", async () => {
		const collection = await registry.createCollection({ slug: "occupied", label: "Occupied" });
		await sql`INSERT INTO ${sql.ref("ec_occupied")} (id, slug) VALUES ('entry-1', 'entry-1')`.execute(
			ctx.db,
		);

		await expect(registry.deleteCollection("occupied")).rejects.toThrow(/has content/i);

		expect(await registry.getCollection("occupied")).not.toBeNull();
		expect(await tableExists(ctx.db, "ec_occupied")).toBe(true);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("capture_state")
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toEqual({ capture_state: "active" });
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select("collection_id")
				.execute(),
		).toEqual([]);
	});

	it("detaches a collection whose only entries are trashed without force", async () => {
		await registry.createCollection({ slug: "trashed", label: "Trashed" });
		await sql`
			INSERT INTO ${sql.ref("ec_trashed")} (id, slug, deleted_at)
			VALUES ('entry-1', 'entry-1', '2026-08-12T00:00:00.000Z')
		`.execute(ctx.db);

		await registry.deleteCollection("trashed");

		expect(await registry.getCollection("trashed")).toBeNull();
		expect(await tableExists(ctx.db, "ec_trashed")).toBe(false);
	});

	it("detaches a non-empty activated collection only when force is explicit", async () => {
		const collection = await registry.createCollection({ slug: "forced", label: "Forced" });
		await sql`INSERT INTO ${sql.ref("ec_forced")} (id, slug) VALUES ('entry-1', 'entry-1')`.execute(
			ctx.db,
		);

		await registry.deleteCollection("forced", { force: true });

		expect(await registry.getCollection("forced")).toBeNull();
		expect(await tableExists(ctx.db, "ec_forced")).toBe(false);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select(["collection_id", "force_delete", "phase"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toEqual({ collection_id: collection.id, force_delete: 1, phase: "work" });
	});

	it("fails closed before a tombstone when exact capture triggers are missing", async () => {
		const collection = await registry.createCollection({ slug: "unfenced", label: "Unfenced" });
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "deleting" })
			.where("collection_id", "=", collection.id)
			.execute();
		await removeMediaUsageCaptureTriggers(ctx.db, {
			collectionId: collection.id,
			collectionSlug: collection.slug,
		});
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", collection.id)
			.execute();

		await expect(registry.deleteCollection("unfenced", { force: true })).rejects.toThrow(
			/capture trigger/i,
		);

		expect(await registry.getCollection("unfenced")).not.toBeNull();
		expect(await tableExists(ctx.db, "ec_unfenced")).toBe(true);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select("collection_id")
				.execute(),
		).toEqual([]);
	});

	it("holds the deleted slug until durable cleanup finalizes", async () => {
		await registry.createCollection({ slug: "reserved", label: "Reserved" });
		await registry.deleteCollection("reserved", { force: true });
		await ctx.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({
				state: "leased",
				lease_token: "other-request",
				lease_expires_at: "2100-01-01T00:00:00.000Z",
			})
			.where("collection_slug", "=", "reserved")
			.execute();

		await expect(
			registry.createCollection({ slug: "reserved", label: "Replacement" }),
		).rejects.toMatchObject({
			code: "COLLECTION_EXISTS",
			message: expect.stringMatching(/being deleted/),
		});
		await expect(
			registry.createSeedCollection({ slug: "reserved", label: "Replacement" }, []),
		).rejects.toMatchObject({
			code: "COLLECTION_EXISTS",
			message: expect.stringMatching(/being deleted/),
		});
		await sql`CREATE TABLE ${sql.ref("ec_reserved")} (id text primary key)`.execute(ctx.db);
		await expect(registry.registerOrphanedTable("reserved")).rejects.toThrow();

		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select("collection_slug")
				.where("collection_slug", "=", "reserved")
				.executeTakeFirst(),
		).toEqual({ collection_slug: "reserved" });
	});

	it("finishes the pending cleanup when a new collection reuses a deleted slug", async () => {
		const deleted = await registry.createCollection({ slug: "products", label: "Products" });
		await registry.deleteCollection("products");

		const recreated = await registry.createCollection({ slug: "products", label: "Products" });

		expect(recreated.id).not.toBe(deleted.id);
		expect(await tableExists(ctx.db, "ec_products")).toBe(true);
		expect(await deletionCount("products")).toBe(0);
		expect(await statusCount(deleted.id)).toBe(0);
	});

	it("removes a force-deleted collection's media usage before reusing its slug", async () => {
		const deleted = await registry.createCollection({ slug: "products", label: "Products" });
		await registry.createField("products", { slug: "hero", label: "Hero", type: "image" });
		const entry = await handleContentCreate(ctx.db, "products", {
			slug: "first",
			data: { hero: { id: "media-1", provider: "local", mimeType: "image/webp" } },
		});
		expect(entry.success).toBe(true);
		expect(await usageRowCount(deleted.id)).toBeGreaterThan(0);
		await registry.deleteCollection("products", { force: true });

		await registry.createCollection({ slug: "products", label: "Products" });

		expect(await usageRowCount(deleted.id)).toBe(0);
		expect(await deletionCount("products")).toBe(0);
	});

	it("finishes the pending cleanup when a seed reuses a deleted slug", async () => {
		await registry.createCollection({ slug: "products", label: "Products" });
		await registry.deleteCollection("products");

		await registry.createSeedCollection({ slug: "products", label: "Products" }, [
			{ slug: "title", label: "Title", type: "string" },
		]);

		expect(await registry.getCollectionWithFields("products")).toMatchObject({
			slug: "products",
			fields: [expect.objectContaining({ slug: "title" })],
		});
		expect(await deletionCount("products")).toBe(0);
	});

	it("leaves the cleanup for a later request once the query budget is spent", async () => {
		await registry.createCollection({ slug: "products", label: "Products" });
		await registry.deleteCollection("products");
		const metrics = createRequestMetrics(performance.now());
		metrics.dbCount = MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling;

		await expect(
			runWithContext({ editMode: false, metrics }, () =>
				registry.createCollection({ slug: "products", label: "Products" }),
			),
		).rejects.toMatchObject({
			code: "COLLECTION_EXISTS",
			message: expect.stringMatching(/being deleted/),
		});
		expect(await registry.getCollection("products")).toBeNull();
		expect(await deletionCount("products")).toBe(1);

		await expect(
			registry.createCollection({ slug: "products", label: "Products" }),
		).resolves.toMatchObject({ slug: "products" });
	});

	it("reports a failed deletion until an operator retries it", async () => {
		const deleted = await registry.createCollection({ slug: "products", label: "Products" });
		await registry.deleteCollection("products");
		await ctx.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({ state: "failed", last_error_code: "MEDIA_USAGE_COLLECTION_DELETION_FAILED" })
			.where("collection_slug", "=", "products")
			.execute();

		await expect(
			registry.createCollection({ slug: "products", label: "Products" }),
		).rejects.toMatchObject({
			code: "COLLECTION_EXISTS",
			message: expect.stringContaining(
				`failed. Retry it by sending {"collectionId":"${deleted.id}"}`,
			),
			details: { deletedCollectionId: deleted.id },
		});
		expect(await deletionCount("products")).toBe(1);

		await expect(
			new MediaUsageCollectionDeletionRepository(ctx.db).retryOperatorDeletion({
				collectionId: deleted.id,
			}),
		).resolves.toMatchObject({ outcome: "pending" });
		await expect(
			registry.createCollection({ slug: "products", label: "Products" }),
		).resolves.toMatchObject({ slug: "products" });
	});

	it("reports a deletion that fails its last attempt during create as failed", async () => {
		const deleted = await registry.createCollection({ slug: "products", label: "Products" });
		await registry.deleteCollection("products");
		await ctx.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({ phase: "finalize", attempt_count: 4 })
			.where("collection_slug", "=", "products")
			.execute();
		await sql`CREATE TABLE ${sql.ref("ec_products")} (id text primary key)`.execute(ctx.db);

		await expect(
			registry.createCollection({ slug: "products", label: "Products" }),
		).rejects.toMatchObject({
			code: "COLLECTION_EXISTS",
			message: expect.stringContaining("failed"),
			details: { deletedCollectionId: deleted.id },
		});
	});

	it("rejects a replacement identity that bypasses the slug producer fence", async () => {
		const deleted = await registry.createCollection({ slug: "conflicted", label: "Conflicted" });
		await registry.deleteCollection("conflicted", { force: true });
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "replacement-id", slug: "conflicted", label: "Replacement" })
			.execute();

		await expect(registry.deleteCollection("conflicted", { force: true })).rejects.toThrow(
			/identity conflict/i,
		);

		expect(await registry.getCollection("conflicted")).toEqual(
			expect.objectContaining({ id: "replacement-id" }),
		);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select("collection_id")
				.where("collection_slug", "=", "conflicted")
				.executeTakeFirst(),
		).toEqual({ collection_id: deleted.id });
	});

	it("resumes after the lifecycle fence commits before its checkpoint", async () => {
		const collection = await registry.createCollection({ slug: "resuming", label: "Resuming" });
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "deleting" })
			.where("collection_id", "=", collection.id)
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collection.id,
				collection_slug: collection.slug,
				force_delete: 1,
				state: "leased",
				phase: "fence",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: "expired-owner",
				lease_expires_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await registry.deleteCollection("resuming", { force: true });

		expect(await registry.getCollection("resuming")).toBeNull();
		expect(await tableExists(ctx.db, "ec_resuming")).toBe(false);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select(["state", "phase"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toEqual({ state: "pending", phase: "work" });
	});

	it("resumes after registry or table removal commits before its checkpoint", async () => {
		for (const phase of ["registry", "table"] as const) {
			const slug = `resume_${phase}`;
			const collection = await registry.createCollection({ slug, label: slug });
			await ctx.db
				.updateTable("_emdash_media_usage_index_status")
				.set({ capture_state: "deleting" })
				.where("collection_id", "=", collection.id)
				.execute();
			await ctx.db
				.insertInto("_emdash_media_usage_collection_deletions")
				.values({
					collection_id: collection.id,
					collection_slug: collection.slug,
					force_delete: 1,
					state: "leased",
					phase,
					next_attempt_at: "2000-01-01T00:00:00.000Z",
					lease_token: "expired-owner",
					lease_expires_at: "2000-01-01T00:00:00.000Z",
				})
				.execute();
			await ctx.db.deleteFrom("_emdash_collections").where("id", "=", collection.id).execute();
			if (phase === "table") {
				await sql`DROP TABLE ${sql.ref(`ec_${slug}`)}`.execute(ctx.db);
			}

			await registry.deleteCollection(slug, { force: true });
			await registry.deleteCollection(slug, { force: true });

			expect(await tableExists(ctx.db, `ec_${slug}`)).toBe(false);
			expect(
				await ctx.db
					.selectFrom("_emdash_media_usage_collection_deletions")
					.select(["state", "phase"])
					.where("collection_id", "=", collection.id)
					.executeTakeFirst(),
			).toEqual({ state: "pending", phase: "work" });
		}
	});

	it.runIf(dialect === "sqlite")(
		"persists the tombstone and fence before removing registry identity or table",
		async () => {
			const collection = await registry.createCollection({ slug: "ordered", label: "Ordered" });
			await sql`
				CREATE TRIGGER assert_collection_deletion_order
				BEFORE DELETE ON _emdash_collections
				WHEN OLD.id = ${sql.lit(collection.id)}
					AND (
						NOT EXISTS (
							SELECT 1 FROM _emdash_media_usage_collection_deletions
							WHERE collection_id = OLD.id
								AND collection_slug = OLD.slug
								AND state = 'leased'
								AND phase = 'registry'
						)
						OR NOT EXISTS (
							SELECT 1 FROM _emdash_media_usage_index_status
							WHERE collection_id = OLD.id AND capture_state = 'deleting'
						)
						OR NOT EXISTS (
							SELECT 1 FROM sqlite_master
							WHERE type = 'table' AND name = 'ec_ordered'
						)
					)
				BEGIN
					SELECT RAISE(ABORT, 'collection deletion order violated');
				END
			`.execute(ctx.db);

			await registry.deleteCollection("ordered", { force: true });

			expect(await registry.getCollection("ordered")).toBeNull();
			expect(await tableExists(ctx.db, "ec_ordered")).toBe(false);
		},
	);

	it.runIf(dialect === "postgres")(
		"waits for an already-authorized canonical projection before registry removal",
		async () => {
			const collection = await registry.createCollection({
				slug: "projecting",
				label: "Projecting",
			});
			const sourceUpdatedAt = "2026-08-12T10:00:00.000Z";
			await sql`
				INSERT INTO ${sql.ref("ec_projecting")} (id, slug, version, updated_at)
				VALUES ('entry-1', 'entry-1', 1, ${sourceUpdatedAt})
			`.execute(ctx.db);
			const advisoryKey = 8642031;
			await sql
				.raw(`
				CREATE FUNCTION pause_collection_projection()
				RETURNS trigger
				LANGUAGE plpgsql
				AS $$
				BEGIN
					PERFORM pg_advisory_xact_lock(8642031);
					RETURN NEW;
				END;
				$$
			`)
				.execute(ctx.db);
			await sql
				.raw(`
				CREATE TRIGGER pause_collection_projection
				BEFORE INSERT ON _emdash_media_usage
				FOR EACH ROW
				EXECUTE FUNCTION pause_collection_projection()
			`)
				.execute(ctx.db);

			let releaseBlocker!: () => void;
			let blockerReady!: () => void;
			const blockerGate = new Promise<void>((resolve) => {
				releaseBlocker = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				blockerReady = resolve;
			});
			const blocker = ctx.db.transaction().execute(async (trx) => {
				await sql`SELECT pg_advisory_xact_lock(${advisoryKey})`.execute(trx);
				blockerReady();
				await blockerGate;
			});
			await ready;

			const sourceKey = `content:v1:${collection.id}:entry-1:columns`;
			const projection = new MediaUsageRepository(ctx.db).replaceSource(
				{
					sourceKey,
					sourceType: "content",
					collectionId: collection.id,
					collectionSlug: collection.slug,
					contentId: "entry-1",
					sourceVariant: "columns",
					revisionId: null,
					sourceVersion: 1,
					sourceUpdatedAt,
					identityVersion: 1,
				},
				[
					{
						fieldSlug: "hero",
						fieldPath: "hero",
						referenceType: "local",
						mediaId: "media-1",
						provider: "local",
						providerAssetId: "media-1",
					},
				],
			);

			let projectionWaiting = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				const waiting = await sql<{ present: boolean }>`
					SELECT EXISTS (
						SELECT 1 FROM pg_locks
						WHERE locktype = 'advisory'
							AND objid = ${advisoryKey}
							AND NOT granted
					) AS present
				`.execute(ctx.db);
				if (waiting.rows[0]?.present) {
					projectionWaiting = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(projectionWaiting).toBe(true);

			let deletionSettled = false;
			const deletion = registry
				.deleteCollection("projecting", { force: true })
				.finally(() => (deletionSettled = true));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(deletionSettled).toBe(false);

			releaseBlocker();
			await blocker;
			await projection;
			await deletion;

			expect(
				await ctx.db
					.selectFrom("_emdash_media_usage_sources")
					.select("source_key")
					.where("source_key", "=", sourceKey)
					.executeTakeFirst(),
			).toEqual({ source_key: sourceKey });
		},
	);

	async function deletionCount(slug: string): Promise<number> {
		const rows = await ctx.db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.where("collection_slug", "=", slug)
			.execute();
		return rows.length;
	}

	async function statusCount(collectionId: string): Promise<number> {
		const rows = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("collection_id")
			.where("collection_id", "=", collectionId)
			.execute();
		return rows.length;
	}

	async function usageRowCount(collectionId: string): Promise<number> {
		const work = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select("content_id")
			.where("collection_id", "=", collectionId)
			.execute();
		const sources = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("collection_id", "=", collectionId)
			.execute();
		return work.length + sources.length;
	}
});

it.each(["collection", "seed", "orphan"] as const)(
	"rechecks the durable slug lock before %s producer mutation",
	async (producer) => {
		const sqlite = new BetterSqlite3(":memory:");
		const prepare = sqlite.prepare.bind(sqlite);
		let armed = false;
		let inserted = false;
		sqlite.prepare = ((source: string) => {
			const statement = prepare(source);
			if (
				!statement.reader ||
				!source.toLowerCase().includes("select") ||
				!source.includes("_emdash_media_usage_collection_deletions") ||
				!source.includes("collection_slug")
			) {
				return statement;
			}
			return new Proxy(statement, {
				get(target, property) {
					if (property === "all") {
						return (parameters?: unknown[]) => {
							const rows = target.all(parameters ?? []);
							if (armed && !inserted) {
								inserted = true;
								prepare(`
									INSERT INTO _emdash_media_usage_collection_deletions (
										collection_id, collection_slug, force_delete, state, phase,
										next_attempt_at
									) VALUES (?, ?, 1, 'pending', 'work', ?)
								`).run("old-collection", "raced", "2000-01-01T00:00:00.000Z");
							}
							return rows;
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}) as typeof sqlite.prepare;
		const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		if (producer === "orphan") {
			await sql`CREATE TABLE ec_raced (id text primary key)`.execute(db);
		}
		armed = true;
		const registry = new SchemaRegistry(db);

		const operation =
			producer === "collection"
				? registry.createCollection({ slug: "raced", label: "Raced" })
				: producer === "seed"
					? registry.createSeedCollection({ slug: "raced", label: "Raced" }, [])
					: registry.registerOrphanedTable("raced");
		await expect(operation).rejects.toThrow();
		expect(inserted).toBe(true);
		expect(await registry.getCollection("raced")).toBeNull();

		await db.destroy();
	},
);

it("stops a create's cleanup after one maintenance step's queries and resumes on the next attempt", async () => {
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
		log: kyselyLogOption(),
	});
	await runMigrations(db);
	await activateMediaUsageCapture(db, { writersDrained: true });
	const registry = new SchemaRegistry(db);
	const deleted = await registry.createCollection({ slug: "products", label: "Products" });
	const sourceCount = 40;
	await db
		.insertInto("_emdash_media_usage_sources")
		.values(
			Array.from({ length: sourceCount }, (_, index) => ({
				source_key: `products-source-${String(index).padStart(2, "0")}`,
				source_type: "content",
				collection_id: deleted.id,
				collection_slug: "products",
				content_id: `entry-${index}`,
				source_variant: "columns",
				current_generation: "generation",
			})),
		)
		.execute();
	await registry.deleteCollection("products", { force: true });
	const remainingSources = async () =>
		(
			await db
				.selectFrom("_emdash_media_usage_sources")
				.select("source_key")
				.where("collection_id", "=", deleted.id)
				.execute()
		).length;

	const metrics = createRequestMetrics(performance.now());
	await expect(
		runWithContext({ editMode: false, metrics }, () =>
			registry.createCollection({ slug: "products", label: "Products" }),
		),
	).rejects.toMatchObject({ message: expect.stringMatching(/being deleted/) });
	const afterFirstAttempt = await remainingSources();
	expect(afterFirstAttempt).toBeGreaterThan(0);
	expect(afterFirstAttempt).toBeLessThan(sourceCount);

	await expect(
		registry.createCollection({ slug: "products", label: "Products" }),
	).resolves.toMatchObject({ slug: "products" });
	expect(await remainingSources()).toBe(0);

	await db.destroy();
});
