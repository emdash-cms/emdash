import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	activateMediaUsageCapture,
	MEDIA_USAGE_ACTIVATION_LIMITS,
} from "../../../src/media/usage/activation.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
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
