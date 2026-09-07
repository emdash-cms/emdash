import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { tableExists } from "../../../src/database/dialect-helpers.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { removeMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
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

		await expect(
			registry.createCollection({ slug: "reserved", label: "Replacement" }),
		).rejects.toThrow();
		await expect(
			registry.createSeedCollection({ slug: "reserved", label: "Replacement" }, []),
		).rejects.toThrow();
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
