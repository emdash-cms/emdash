import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentPublish } from "../../src/api/handlers/content.js";
import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { ScheduledNotDueError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { createHookPipeline } from "../../src/plugins/hooks.js";
import { publishDueContent, type ScheduledPublishFn } from "../../src/scheduled-publish.js";
import { createPostFixture, createPageFixture } from "../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

function buildRuntime(db: Kysely<Database>): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef: { current: hooks },
	});
}

describe("publishDueContent()", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("promotes a scheduled draft whose time has passed", async () => {
		const post = await repo.create(createPostFixture());
		// schedule() rejects past dates, so set the past schedule directly —
		// this is the state a post reaches once its future schedule arrives.
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		const published = await publishDueContent(db);

		expect(published).toEqual([{ collection: "post", id: post.id }]);

		const updated = await repo.findById("post", post.id);
		expect(updated?.status).toBe("published");
		expect(updated?.publishedAt).toBeTruthy();
		expect(updated?.scheduledAt).toBeNull();
	});

	it("leaves future-scheduled content untouched", async () => {
		const post = await repo.create(createPostFixture());
		const future = new Date(Date.now() + 86_400_000).toISOString();
		await repo.schedule("post", post.id, future);

		const published = await publishDueContent(db);

		expect(published).toEqual([]);
		const updated = await repo.findById("post", post.id);
		expect(updated?.status).toBe("scheduled");
	});

	it("records the scheduled time as published_at, not the (later) sweep time", async () => {
		const post = await repo.create(createPostFixture());
		// Scheduled for the past; the sweep runs "now", which is later.
		const scheduledFor = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: scheduledFor });

		await publishDueContent(db);

		const updated = await repo.findById("post", post.id);
		// First publication should preserve the intended publish time.
		expect(updated?.publishedAt).toBe(scheduledFor);
	});

	it("routes each publish through the provided callback with requireScheduledDue", async () => {
		const post = await repo.create(createPostFixture());
		const scheduledFor = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: scheduledFor });

		const calls: Array<{ collection: string; id: string; options: unknown }> = [];
		const spy: ScheduledPublishFn = (collection, id, options) => {
			calls.push({ collection, id, options });
			return handleContentPublish(db, collection, id, options);
		};

		const published = await publishDueContent(db, spy);

		expect(published).toEqual([{ collection: "post", id: post.id }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toEqual({
			publishedAt: scheduledFor,
			requireScheduledDue: true,
		});
	});

	it("skips (without failing) items the publish callback reports as NOT_DUE", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		// Simulate the unschedule-during-sweep race: the callback reports the
		// item is no longer due. The sweep must treat this as a quiet skip.
		const published = await publishDueContent(db, async () => ({
			success: false,
			error: { code: "NOT_DUE" },
		}));

		expect(published).toEqual([]);
	});

	it("sweeps every collection and is idempotent across runs", async () => {
		const post = await repo.create(createPostFixture());
		const page = await repo.create(createPageFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		await repo.update("page", page.id, { status: "scheduled", scheduledAt: past });

		const first = await publishDueContent(db);
		expect(first).toHaveLength(2);
		expect(first.map((r) => r.collection).toSorted()).toEqual(["page", "post"]);

		// A second sweep finds nothing — publish cleared scheduled_at.
		const second = await publishDueContent(db);
		expect(second).toEqual([]);
	});
});

describe("EmDashRuntime.runScheduledTasks()", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// This is the exact method the Cloudflare scheduled() handler invokes via
	// runScheduledTasks(). It must promote due content and report it.
	it("promotes due content and returns it for cache invalidation", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		const runtime = buildRuntime(db);
		const { published } = await runtime.runScheduledTasks();

		expect(published).toEqual([{ collection: "post", id: post.id }]);
		const updated = await repo.findById("post", post.id);
		expect(updated?.status).toBe("published");
	});
});

describe("ContentRepository.publish() requireDue gate", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("publishes a still-due item", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		const result = await repo.publish("post", post.id, undefined, true);
		expect(result.status).toBe("published");
	});

	it("refuses to publish an item that was unscheduled (race guard)", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		// Editor unschedules between selection and publish.
		await repo.unschedule("post", post.id);

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toBeInstanceOf(
			ScheduledNotDueError,
		);

		const updated = await repo.findById("post", post.id);
		expect(updated?.status).toBe("draft");
	});

	it("claims the schedule so a second (overlapping) publish bails — no double publish", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		// First claim wins and publishes.
		const first = await repo.publish("post", post.id, undefined, true);
		expect(first.status).toBe("published");

		// A concurrent/duplicate sweep that already selected this row before the
		// first claim cleared scheduled_at must now affect 0 rows and bail.
		await expect(repo.publish("post", post.id, undefined, true)).rejects.toBeInstanceOf(
			ScheduledNotDueError,
		);
	});

	it("refuses to publish an item rescheduled into the future", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		// Pushed out to the future before the sweep reaches it.
		const future = new Date(Date.now() + 86_400_000).toISOString();
		await repo.update("post", post.id, { scheduledAt: future });

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toBeInstanceOf(
			ScheduledNotDueError,
		);
	});

	it("restores the schedule if publish work fails after the claim (no-transaction path)", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		// Force a failure AFTER the atomic claim has cleared scheduled_at. This
		// repo is unwrapped (no withTransaction), mimicking D1 where the claim is
		// already durable when later work throws.
		const spy = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockRejectedValueOnce(new Error("boom"));

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toThrow("boom");
		spy.mockRestore();

		const after = await repo.findById("post", post.id);
		// Schedule put back so a later sweep retries — not silently dropped.
		expect(after?.scheduledAt).toBe(past);
		expect(after?.status).toBe("scheduled");
	});

	it("does not re-add a schedule when the row was fully published in the failure window", async () => {
		const post = await repo.create(createPostFixture());
		// Publish it: status=published, draft_revision_id cleared. This is the
		// state a concurrent manual publish would leave the row in.
		await repo.publish("post", post.id);
		// A stray schedule on an already-published row with no pending draft.
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { scheduledAt: past });

		const spy = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockRejectedValueOnce(new Error("boom"));

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toThrow("boom");
		spy.mockRestore();

		const after = await repo.findById("post", post.id);
		// Restore is suppressed — no redundant republish next sweep.
		expect(after?.scheduledAt).toBeNull();
		expect(after?.status).toBe("published");
	});

	it("ignores the gate when requireDue is false (manual publish path)", async () => {
		const post = await repo.create(createPostFixture());
		// Plain draft, never scheduled.
		const result = await repo.publish("post", post.id);
		expect(result.status).toBe("published");
	});
});
