import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { sql, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import type { CronScheduler, SystemCleanupFn } from "../../../src/plugins/scheduler/types.js";

describe("media usage scheduled drivers", () => {
	let runtime: EmDashRuntime | null = null;

	afterEach(async () => {
		await runtime?.stopCron();
		runtime = null;
	});

	it("drains bounded work from the Cloudflare scheduled entry point", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "cloudflare_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");

		await runtime.runScheduledTasks();

		expect(await countWork(runtime)).toBe(0);
		expect(
			await new MediaUsageRepository(runtime.db).findSource(
				canonicalSourceKey(fixture.collectionId, "entry-1"),
			),
		).not.toBeNull();
	});

	it("drains bounded work from the Node timer maintenance callback", async () => {
		const scheduler = new CapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		const fixture = await activateCollection(runtime, "node_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");

		await scheduler.runMaintenance();

		expect(await countWork(runtime)).toBe(0);
		expect(
			await new MediaUsageRepository(runtime.db).findSource(
				canonicalSourceKey(fixture.collectionId, "entry-1"),
			),
		).not.toBeNull();
	});

	it("advances bounded collection deletion from the Cloudflare scheduled entry point", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "cloudflare_delete");
		await runtime.schemaRegistry.deleteCollection("cloudflare_delete", { force: true });

		await runtime.runScheduledTasks();

		expect(await deletionPhase(runtime, fixture.collectionId)).toBe("sources");
	});

	it("advances bounded collection deletion from the Node maintenance callback", async () => {
		const scheduler = new CapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		const fixture = await activateCollection(runtime, "node_delete");
		await runtime.schemaRegistry.deleteCollection("node_delete", { force: true });

		await scheduler.runMaintenance();

		expect(await deletionPhase(runtime, fixture.collectionId)).toBe("sources");
	});

	it("processes a trigger-created job before returning from an authenticated write", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "fast_posts");

		const result = await runtime.handleContentCreate("fast_posts", {
			slug: "entry-1",
			status: "published",
			data: { title: "Entry 1" },
		});

		expect(result.success).toBe(true);
		const contentId = result.data?.item.id;
		expect(contentId).toBeTruthy();
		expect(await countWork(runtime)).toBe(0);
		expect(
			await new MediaUsageRepository(runtime.db).findSource(
				canonicalSourceKey(fixture.collectionId, contentId!),
			),
		).not.toBeNull();
	});
});

class CapturingScheduler implements CronScheduler {
	private maintenance: SystemCleanupFn | null = null;

	setSystemCleanup(fn: SystemCleanupFn): void {
		this.maintenance = fn;
	}

	start(): void {}
	stop(): void {}
	reschedule(): void {}

	async runMaintenance(): Promise<void> {
		if (!this.maintenance) throw new Error("Expected Node maintenance callback");
		await this.maintenance();
	}
}

function createDeps(createScheduler: RuntimeDependencies["createScheduler"]): RuntimeDependencies {
	return {
		config: {
			database: {
				entrypoint: `test-media-usage-scheduler-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

async function activateCollection(runtime: EmDashRuntime, collectionSlug: string) {
	await runtime.schemaRegistry.createCollection({ slug: collectionSlug, label: collectionSlug });
	await runtime.schemaRegistry.createField(collectionSlug, {
		slug: "title",
		label: "Title",
		type: "string",
	});
	const collection = await runtime.schemaRegistry.getCollection(collectionSlug);
	if (!collection) throw new Error(`Expected ${collectionSlug} collection`);

	await runtime.db
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
	await installMediaUsageCaptureTriggers(runtime.db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await runtime.db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await runtime.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();

	return { collectionId: collection.id, tableName: `ec_${collectionSlug}` };
}

async function insertEntry(
	runtime: EmDashRuntime,
	tableName: string,
	contentId: string,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(tableName)} (id, slug, status, title)
		VALUES (${contentId}, ${contentId}, 'published', ${contentId})
	`.execute(runtime.db);
}

async function countWork(runtime: EmDashRuntime): Promise<number> {
	const row = await runtime.db
		.selectFrom("_emdash_media_usage_work")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(row.count);
}

async function deletionPhase(runtime: EmDashRuntime, collectionId: string): Promise<string | null> {
	const row = await runtime.db
		.selectFrom("_emdash_media_usage_collection_deletions")
		.select("phase")
		.where("collection_id", "=", collectionId)
		.executeTakeFirst();
	return row?.phase ?? null;
}

function canonicalSourceKey(collectionId: string, contentId: string): string {
	return `content:${collectionId}:${contentId}:columns`;
}
