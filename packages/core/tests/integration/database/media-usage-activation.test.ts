import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { findMediaUsageActivationWriteFenceError } from "../../../src/api/media-usage-write-fence.js";
import {
	activateMediaUsageCapture,
	canResumeMediaUsageCollectionCapture,
	MEDIA_USAGE_ACTIVATION_LIMITS,
} from "../../../src/media/usage/activation.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { invalidateContentMediaUsageSchemaChange } from "../../../src/media/usage/content-refresh.js";
import {
	buildSeedCollectionCaptureFingerprint,
	SchemaRegistry,
} from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage production activation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("requires explicit writer-drain confirmation before reading or changing activation state", async () => {
		const before = await activationRow();

		await expect(
			activateMediaUsageCapture(ctx.db, {
				// Exercise the JavaScript boundary rather than the compile-time literal.
				writersDrained: false as true,
			}),
		).rejects.toThrow(/writers.*drained/i);

		expect(await activationRow()).toEqual(before);
	});

	it("treats a missing activation table as inactive without aborting the transaction", async () => {
		await ctx.db.schema.dropTable("_emdash_media_usage_activation").execute();

		const result = await ctx.db.transaction().execute(async (trx) => {
			const resumable = await canResumeMediaUsageCollectionCapture(trx, {
				collectionId: "missing-collection",
				collectionSlug: "missing_collection",
			});
			const writeFence = await findMediaUsageActivationWriteFenceError(trx);
			const schemaInvalidated = await invalidateContentMediaUsageSchemaChange(
				trx,
				"missing_collection",
			);
			const probe = await sql<{ value: number | string }>`SELECT 1 AS value`.execute(trx);
			return {
				resumable,
				schemaInvalidated,
				transactionValue: Number(probe.rows[0]?.value),
				writeFence,
			};
		});

		expect(result).toEqual({
			resumable: false,
			schemaInvalidated: false,
			transactionValue: 1,
			writeFence: null,
		});
	});

	it("activates an empty installation explicitly and is then an idempotent no-op", async () => {
		const first = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		expect(first).toEqual({ outcome: "active", processedCollections: 0 });

		const activated = await activationRow();
		expect(activated).toEqual(
			expect.objectContaining({
				state: "active",
				lease_token: null,
				lease_expires_at: null,
				last_error_code: null,
				activated_at: expect.any(String),
				drain_confirmed_at: expect.any(String),
			}),
		);

		const second = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		expect(second).toEqual({ outcome: "active", processedCollections: 0 });
		expect(await activationRow()).toEqual(activated);
	});

	it("activates durable capture for collections created after global activation", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);

		const collection = await registry.createCollection({ slug: "posts", label: "Posts" });

		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({
				collection_id: collection.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
		await sql`INSERT INTO ${sql.ref("ec_posts")} (id, slug) VALUES ('post-1', 'post-1')`.execute(
			ctx.db,
		);
		expect(await workRows()).toEqual([
			expect.objectContaining({ collection_id: collection.id, content_id: "post-1" }),
		]);
	});

	it("activates durable capture for seed collections created after global activation", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);

		await registry.createSeedCollection({ slug: "posts", label: "Posts" }, []);
		const collection = await registry.getCollection("posts");
		if (!collection) throw new Error("Expected seed collection");

		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({
				collection_id: collection.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
		await sql`INSERT INTO ${sql.ref("ec_posts")} (id, slug) VALUES ('post-1', 'post-1')`.execute(
			ctx.db,
		);
		expect(await workRows()).toEqual([
			expect.objectContaining({ collection_id: collection.id, content_id: "post-1" }),
		]);
	});

	it("rejects seed writes until field metadata and capture publication are complete", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const input = { slug: "posts", label: "Posts" };
		const fields = [{ slug: "hero", label: "Hero", type: "image" as const }];
		await registry.createSeedCollection(input, fields);
		const collection = await registry.getCollection("posts");
		if (!collection) throw new Error("Expected seed collection");

		await ctx.db.deleteFrom("_emdash_fields").where("collection_id", "=", collection.id).execute();
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				capture_state: "ready",
				cursor: await buildSeedCollectionCaptureFingerprint(input, fields),
			})
			.where("collection_id", "=", collection.id)
			.execute();

		await expect(
			sql`
				INSERT INTO ${sql.ref("ec_posts")} (id, slug, hero)
				VALUES (
					'post-during-publication',
					'post-during-publication',
					${JSON.stringify({ id: "media-hero", provider: "local" })}
				)
			`.execute(ctx.db),
		).rejects.toThrow(/media usage capture inactive/i);
		expect(await workRows()).toEqual([]);

		await registry.createSeedCollection(input, fields);
		await sql`
			INSERT INTO ${sql.ref("ec_posts")} (id, slug, hero)
			VALUES (
				'post-after-publication',
				'post-after-publication',
				${JSON.stringify({ id: "media-hero", provider: "local" })}
			)
		`.execute(ctx.db);
		expect(await workRows()).toEqual([
			expect.objectContaining({
				collection_id: collection.id,
				content_id: "post-after-publication",
			}),
		]);
	});

	it("activates durable capture when registering an orphan after global activation", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await sql`CREATE TABLE ${sql.ref("ec_orphan_posts")} (id text primary key)`.execute(ctx.db);
		const registry = new SchemaRegistry(ctx.db);

		const collection = await registry.registerOrphanedTable("orphan_posts");

		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({
				collection_id: collection.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
		await sql`INSERT INTO ${sql.ref("ec_orphan_posts")} (id) VALUES ('post-1')`.execute(ctx.db);
		expect(await workRows()).toEqual([
			expect.objectContaining({ collection_id: collection.id, content_id: "post-1" }),
		]);
	});

	it("rejects orphan writes until collection publication is active and resumes registration", async () => {
		if (dialect !== "sqlite") return;
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await sql`CREATE TABLE ${sql.ref("ec_orphan_posts")} (id text primary key)`.execute(ctx.db);
		await sql`
			CREATE TRIGGER write_after_collection_publication
			AFTER INSERT ON _emdash_collections
			WHEN NEW.slug = 'orphan_posts'
			BEGIN
				INSERT INTO ec_orphan_posts (id) VALUES ('post-during-publication');
			END
		`.execute(ctx.db);
		const registry = new SchemaRegistry(ctx.db);

		await expect(registry.registerOrphanedTable("orphan_posts")).rejects.toThrow(
			/media usage capture inactive/i,
		);
		expect(await registry.getCollection("orphan_posts")).toBeNull();
		expect(await workRows()).toEqual([]);
		const orphanContent = await sql<{ id: string }>`
			SELECT id FROM ${sql.ref("ec_orphan_posts")}
		`.execute(ctx.db);
		expect(orphanContent.rows).toEqual([]);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("capture_state")
				.where("adapter_id", "=", "content-media")
				.where("scope_type", "=", "collection")
				.where("scope_key", "=", "orphan_posts")
				.executeTakeFirst(),
		).toEqual({ capture_state: "ready" });

		await sql`DROP TRIGGER write_after_collection_publication`.execute(ctx.db);
		const collection = await registry.registerOrphanedTable("orphan_posts");

		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
		await sql`INSERT INTO ${sql.ref("ec_orphan_posts")} (id) VALUES ('post-after-publication')`.execute(
			ctx.db,
		);
		expect(await workRows()).toEqual([
			expect.objectContaining({
				collection_id: collection.id,
				content_id: "post-after-publication",
			}),
		]);
	});

	it("resumes collection capture after the content table commits before registration", async () => {
		const registry = new SchemaRegistry(ctx.db);
		const interrupted = await registry.createCollection({ slug: "posts", label: "Posts" });
		await ctx.db.deleteFrom("_emdash_collections").where("id", "=", interrupted.id).execute();
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "never",
				collection_id: interrupted.id,
				reconciliation_required: 1,
				capture_state: "installing",
			})
			.execute();

		const resumed = await registry.createCollection({ slug: "posts", label: "Posts" });

		expect(resumed.id).toBe(interrupted.id);
		expect(await statusRow(resumed.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	it("resumes collection publication after verified capture reaches ready", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const interrupted = await registry.createCollection({ slug: "posts", label: "Posts" });
		await ctx.db.deleteFrom("_emdash_collections").where("id", "=", interrupted.id).execute();
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "ready" })
			.where("collection_id", "=", interrupted.id)
			.execute();

		const resumed = await registry.createCollection({ slug: "posts", label: "Posts" });

		expect(resumed.id).toBe(interrupted.id);
		expect(await statusRow(resumed.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	it("resumes collection capture after registration commits before finalization", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const interrupted = await registry.createCollection({ slug: "posts", label: "Posts" });
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", interrupted.id)
			.execute();

		const resumed = await registry.createCollection({ slug: "posts", label: "Posts" });

		expect(resumed.id).toBe(interrupted.id);
		expect(await statusRow(resumed.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	it("resumes seed capture and restores missing field metadata before finalization", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const input = { slug: "posts", label: "Posts" };
		const fields = [{ slug: "hero", label: "Hero", type: "image" as const }];
		await registry.createSeedCollection(input, fields);
		const interrupted = await registry.getCollection("posts");
		if (!interrupted) throw new Error("Expected seed collection");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				capture_state: "installing",
				cursor: await buildSeedCollectionCaptureFingerprint(input, fields),
			})
			.where("collection_id", "=", interrupted.id)
			.execute();
		await ctx.db
			.deleteFrom("_emdash_fields")
			.where("collection_id", "=", interrupted.id)
			.where("slug", "=", "hero")
			.execute();

		await registry.createSeedCollection(input, fields);

		expect((await registry.listFields(interrupted.id)).map((field) => field.slug)).toEqual([
			"hero",
		]);
		expect(await statusRow(interrupted.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	it("rejects a conflicting seed definition while capture installation is incomplete", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const input = { slug: "posts", label: "Posts" };
		const fields = [{ slug: "hero", label: "Hero", type: "image" as const }];
		await registry.createSeedCollection(input, fields);
		const interrupted = await registry.getCollection("posts");
		if (!interrupted) throw new Error("Expected seed collection");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				capture_state: "installing",
				cursor: await buildSeedCollectionCaptureFingerprint(input, fields),
			})
			.where("collection_id", "=", interrupted.id)
			.execute();
		await ctx.db.deleteFrom("_emdash_fields").where("collection_id", "=", interrupted.id).execute();

		await expect(
			registry.createSeedCollection({ slug: "posts", label: "Posts" }, [
				{ slug: "title", label: "Title", type: "string" },
			]),
		).rejects.toThrow();
		expect(await registry.listFields(interrupted.id)).toEqual([]);
		expect(await statusRow(interrupted.id)).toEqual(
			expect.objectContaining({ capture_state: "installing" }),
		);
	});

	it("does not resume a cursorless collection lifecycle as seed creation", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const interrupted = await registry.createCollection({ slug: "posts", label: "Posts" });
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing", cursor: null })
			.where("collection_id", "=", interrupted.id)
			.execute();

		await expect(
			registry.createSeedCollection({ slug: "posts", label: "Posts" }, [
				{ slug: "hero", label: "Hero", type: "image" },
			]),
		).rejects.toThrow();
		expect(await registry.listFields(interrupted.id)).toEqual([]);
		expect(await statusRow(interrupted.id)).toEqual(
			expect.objectContaining({ capture_state: "installing", cursor: null }),
		);
	});

	it("does not resume a fingerprinted seed lifecycle as ordinary collection creation", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const input = { slug: "posts", label: "Posts" };
		const fields = [{ slug: "hero", label: "Hero", type: "image" as const }];
		await registry.createSeedCollection(input, fields);
		const interrupted = await registry.getCollection("posts");
		if (!interrupted) throw new Error("Expected seed collection");
		const fingerprint = await buildSeedCollectionCaptureFingerprint(input, fields);
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing", cursor: fingerprint })
			.where("collection_id", "=", interrupted.id)
			.execute();

		await expect(registry.createCollection(input)).rejects.toThrow();
		expect(await statusRow(interrupted.id)).toEqual(
			expect.objectContaining({ capture_state: "installing", cursor: fingerprint }),
		);
	});

	it("includes collection routability in the seed capture fingerprint", async () => {
		const fields = [{ slug: "hero", label: "Hero", type: "image" as const }];
		const routable = await buildSeedCollectionCaptureFingerprint(
			{ slug: "posts", label: "Posts", routable: true },
			fields,
		);
		const nonRoutable = await buildSeedCollectionCaptureFingerprint(
			{ slug: "posts", label: "Posts", routable: false },
			fields,
		);

		expect(nonRoutable).not.toBe(routable);
	});

	it("distinguishes an omitted seed default from an explicit null default", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const input = { slug: "posts", label: "Posts" };
		const originalFields = [
			{ slug: "settings", label: "Settings", type: "json" as const, required: true },
		];
		await registry.createSeedCollection(input, originalFields);
		const interrupted = await registry.getCollection("posts");
		if (!interrupted) throw new Error("Expected seed collection");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				capture_state: "installing",
				cursor: await buildSeedCollectionCaptureFingerprint(input, originalFields),
			})
			.where("collection_id", "=", interrupted.id)
			.execute();
		await ctx.db.deleteFrom("_emdash_fields").where("collection_id", "=", interrupted.id).execute();

		await expect(
			registry.createSeedCollection(input, [
				{
					slug: "settings",
					label: "Settings",
					type: "json",
					required: true,
					defaultValue: null,
				},
			]),
		).rejects.toThrow();
		expect(await registry.listFields(interrupted.id)).toEqual([]);
		expect(await statusRow(interrupted.id)).toEqual(
			expect.objectContaining({ capture_state: "installing" }),
		);
	});

	it("resumes orphan registration after publication commits before finalization", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await sql`CREATE TABLE ${sql.ref("ec_orphan_posts")} (id text primary key)`.execute(ctx.db);
		const registry = new SchemaRegistry(ctx.db);
		const interrupted = await registry.registerOrphanedTable("orphan_posts");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", interrupted.id)
			.execute();

		const resumed = await registry.registerOrphanedTable("orphan_posts");

		expect(resumed.id).toBe(interrupted.id);
		expect(await statusRow(resumed.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	it("activates one bounded collection per call and captures writes only after each exact lifecycle", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "alpha", label: "Alpha" });
		await registry.createCollection({ slug: "beta", label: "Beta" });
		const alpha = await registry.getCollection("alpha");
		const beta = await registry.getCollection("beta");
		if (!alpha || !beta) throw new Error("Expected activation collections");

		const first = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		expect(first).toEqual({
			outcome: "activating",
			processedCollections: MEDIA_USAGE_ACTIVATION_LIMITS.collectionsPerCall,
			collectionCursor: "alpha",
		});
		expect(await statusRow(alpha.id)).toEqual(
			expect.objectContaining({
				status: "never",
				collection_id: alpha.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
		expect(await statusRow(beta.id)).toBeUndefined();

		await sql`INSERT INTO ${sql.ref("ec_alpha")} (id, slug) VALUES ('alpha-1', 'alpha-1')`.execute(
			ctx.db,
		);
		expect(await workRows()).toEqual([
			expect.objectContaining({ collection_id: alpha.id, content_id: "alpha-1" }),
		]);

		const second = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		expect(second).toEqual({ outcome: "active", processedCollections: 1 });
		expect(await statusRow(beta.id)).toEqual(
			expect.objectContaining({
				collection_id: beta.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
	});

	it("conservatively invalidates trusted coverage before activating capture", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		const collection = await registry.getCollection("posts");
		if (!collection) throw new Error("Expected posts collection");
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				cursor: "old-repair",
			})
			.execute();

		await activateMediaUsageCapture(ctx.db, { writersDrained: true });

		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({
				status: "stale",
				completed_at: null,
				cursor: null,
				collection_id: collection.id,
				capture_state: "active",
				reconciliation_required: 1,
			}),
		);
	});

	it("does not steal a live activation lease and takes over an expired lease", async () => {
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				lease_token: "current-owner",
				lease_expires_at: "2100-01-01T00:00:00.000Z",
				drain_confirmed_at: "2026-08-01T00:00:00.000Z",
			})
			.execute();

		expect(await activateMediaUsageCapture(ctx.db, { writersDrained: true })).toEqual({
			outcome: "lease_active",
			leaseExpiresAt: "2100-01-01T00:00:00.000Z",
		});
		expect(await activationRow()).toEqual(
			expect.objectContaining({ lease_token: "current-owner", attempt_count: 0 }),
		);

		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
			.execute();
		expect(await activateMediaUsageCapture(ctx.db, { writersDrained: true })).toEqual({
			outcome: "active",
			processedCollections: 0,
		});
		expect(await activationRow()).toEqual(
			expect.objectContaining({ state: "active", attempt_count: 1, lease_token: null }),
		);
	});

	it("fails closed with durable diagnostics when trigger installation cannot finish", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "broken", label: "Broken" });
		const collection = await registry.getCollection("broken");
		if (!collection) throw new Error("Expected broken collection");
		await sql`DROP TABLE ${sql.ref("ec_broken")}`.execute(ctx.db);

		await expect(activateMediaUsageCapture(ctx.db, { writersDrained: true })).rejects.toThrow(
			/activation failed/i,
		);

		expect(await activationRow()).toEqual(
			expect.objectContaining({
				state: "activating",
				lease_token: null,
				lease_expires_at: null,
				last_error_code: "MEDIA_USAGE_ACTIVATION_FAILED",
				activated_at: null,
			}),
		);
		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({ capture_state: "installing", reconciliation_required: 1 }),
		);
	});

	it("rejects an excessive owned trigger set before changing trigger DDL", async () => {
		if (dialect !== "sqlite") return;
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "trigger_limit", label: "Trigger limit" });
		for (let index = 0; index < 150; index++) {
			const triggerName = `emdash_mu_extra_${String(index).padStart(3, "0")}`;
			await sql`
				CREATE TRIGGER ${sql.ref(triggerName)}
				AFTER INSERT ON ${sql.ref("ec_trigger_limit")}
				BEGIN
					SELECT 1;
				END
			`.execute(ctx.db);
		}

		await expect(activateMediaUsageCapture(ctx.db, { writersDrained: true })).rejects.toThrow(
			/activation failed/i,
		);

		const triggers = await sql<{ name: string }>`
			SELECT name FROM sqlite_master
			WHERE type = 'trigger'
				AND tbl_name = 'ec_trigger_limit'
				AND substr(name, 1, 10) = 'emdash_mu_'
		`.execute(ctx.db);
		expect(triggers.rows).toHaveLength(150);
		expect(await activationRow()).toEqual(
			expect.objectContaining({
				state: "activating",
				lease_token: null,
				last_error_code: "MEDIA_USAGE_ACTIVATION_FAILED",
			}),
		);
	});

	it("refuses a runtime generation mismatch without changing activation state", async () => {
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ runtime_generation: 2 })
			.execute();
		const before = await activationRow();

		await expect(activateMediaUsageCapture(ctx.db, { writersDrained: true })).rejects.toThrow(
			/runtime generation/i,
		);
		expect(await activationRow()).toEqual(before);
	});

	it("cannot finalize after losing its exact lease during collection activation", async () => {
		if (dialect !== "sqlite") return;
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "lease_loss", label: "Lease loss" });
		await sql`
			CREATE TRIGGER steal_media_usage_activation_lease
			AFTER UPDATE OF capture_state ON _emdash_media_usage_index_status
			WHEN NEW.capture_state = 'active'
			BEGIN
				UPDATE _emdash_media_usage_activation
				SET lease_token = 'new-owner',
					lease_expires_at = '2100-01-01T00:00:00.000Z'
				WHERE task_key = 'incremental_capture';
			END
		`.execute(ctx.db);

		expect(await activateMediaUsageCapture(ctx.db, { writersDrained: true })).toEqual({
			outcome: "conflict",
			processedCollections: 1,
		});
		expect(await activationRow()).toEqual(
			expect.objectContaining({
				state: "activating",
				lease_token: "new-owner",
				activated_at: null,
			}),
		);
	});

	it("cannot downgrade an active collection after its activation lease is taken over", async () => {
		if (dialect !== "sqlite") return;
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "takeover", label: "Takeover" });
		const collection = await registry.getCollection("takeover");
		if (!collection) throw new Error("Expected takeover collection");
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: collection.slug,
				collection_id: collection.id,
				status: "never",
				reconciliation_required: 1,
				capture_state: "installing",
			})
			.execute();
		await installMediaUsageCaptureTriggers(ctx.db, {
			collectionId: collection.id,
			collectionSlug: collection.slug,
		});
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", collection.id)
			.execute();
		await sql`
			CREATE TRIGGER steal_media_usage_activation_claim
			AFTER UPDATE OF lease_token ON _emdash_media_usage_activation
			WHEN NEW.lease_token IS NOT NULL AND NEW.lease_token <> 'new-owner'
			BEGIN
				UPDATE _emdash_media_usage_activation
				SET lease_token = 'new-owner',
					lease_expires_at = '2100-01-01T00:00:00.000Z'
				WHERE task_key = 'incremental_capture';
			END
		`.execute(ctx.db);

		expect(await activateMediaUsageCapture(ctx.db, { writersDrained: true })).toEqual({
			outcome: "conflict",
			processedCollections: 0,
		});
		expect(await statusRow(collection.id)).toEqual(
			expect.objectContaining({ capture_state: "active" }),
		);
	});

	async function activationRow() {
		return ctx.db
			.selectFrom("_emdash_media_usage_activation")
			.selectAll()
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
	}

	async function statusRow(collectionId: string) {
		return ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("collection_id", "=", collectionId)
			.executeTakeFirst();
	}

	function workRows() {
		return ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select(["collection_id", "content_id"])
			.orderBy("collection_id")
			.orderBy("content_id")
			.execute();
	}
});
