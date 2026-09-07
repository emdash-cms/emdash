import { sql, type Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentPublish } from "../../src/api/handlers/content.js";
import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import {
	ContentMutationConflictError,
	ScheduledNotDueError,
} from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { createHookPipeline } from "../../src/plugins/hooks.js";
import {
	publishDueContent,
	type PublishedRef,
	type ScheduledPublishFn,
} from "../../src/scheduled-publish.js";
import { SCHEDULER_HEARTBEAT_OPTION } from "../../src/scheduler-health.js";
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
		vi.restoreAllMocks();
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

		const published = await publishDueContent(db, { publish: spy });

		expect(published).toEqual([{ collection: "post", id: post.id }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toEqual({
			publishedAt: scheduledFor,
			requireScheduledDue: true,
			expectedScheduledAt: scheduledFor,
		});
	});

	it("skips (without failing) items the publish callback reports as NOT_DUE", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		// Simulate the unschedule-during-sweep race: the callback reports the
		// item is no longer due. The sweep must treat this as a quiet skip.
		const published = await publishDueContent(db, {
			publish: async () => ({
				success: false,
				error: { code: "NOT_DUE" },
			}),
		});

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

	it("bounds promotions per collection per sweep and drains the rest on later sweeps", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		for (let i = 0; i < 3; i++) {
			const post = await repo.create(createPostFixture({ slug: `due-${i}` }));
			await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		}

		// limit 2 → first sweep promotes 2, leaves 1 for the next tick.
		const first = await publishDueContent(db, { limit: 2 });
		expect(first).toHaveLength(2);

		const second = await publishDueContent(db, { limit: 2 });
		expect(second).toHaveLength(1);

		const third = await publishDueContent(db, { limit: 2 });
		expect(third).toEqual([]);
	});

	it("invokes onPublished once per non-empty collection batch with only that batch's refs", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const post = await repo.create(createPostFixture());
		const page = await repo.create(createPageFixture());
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		await repo.update("page", page.id, { status: "scheduled", scheduledAt: past });

		const batches: PublishedRef[][] = [];
		const published = await publishDueContent(db, {
			onPublished: async (refs) => {
				batches.push(refs);
			},
		});

		expect(published).toHaveLength(2);
		// One invocation per collection that published something.
		expect(batches).toHaveLength(2);
		// Each batch carries refs for exactly one collection (incremental purge).
		for (const batch of batches) {
			expect(new Set(batch.map((r) => r.collection)).size).toBe(1);
		}
	});

	it("treats an onPublished failure as non-fatal — content still publishes", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const post = await repo.create(createPostFixture());
		const page = await repo.create(createPageFixture());
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		await repo.update("page", page.id, { status: "scheduled", scheduledAt: past });

		const published = await publishDueContent(db, {
			onPublished: async () => {
				throw new Error("invalidate boom");
			},
		});

		// Both still published despite the hook throwing on every batch.
		expect(published).toHaveLength(2);
		expect((await repo.findById("post", post.id))?.status).toBe("published");
		expect((await repo.findById("page", page.id))?.status).toBe("published");
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

	it("records a heartbeat after Cloudflare scheduled maintenance completes", async () => {
		const runtime = buildRuntime(db);
		const options = new OptionsRepository(db);
		const startedAt = Date.now();

		await runtime.runScheduledTasks();

		const heartbeat = await options.get<string>(SCHEDULER_HEARTBEAT_OPTION);
		expect(heartbeat).not.toBeNull();
		expect(Date.parse(heartbeat!)).toBeGreaterThanOrEqual(startedAt);
	});

	it("does not fail Cloudflare scheduled maintenance when the heartbeat write fails", async () => {
		await sql`
			CREATE TRIGGER fail_scheduler_heartbeat
			BEFORE INSERT ON options
			WHEN NEW.name = ${sql.lit(SCHEDULER_HEARTBEAT_OPTION)}
			BEGIN
				SELECT RAISE(ABORT, 'heartbeat unavailable');
			END
		`.execute(db);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(buildRuntime(db).runScheduledTasks()).resolves.toEqual({ published: [] });
		expect(consoleError).toHaveBeenCalledWith(
			"[scheduler] Failed to record heartbeat:",
			expect.anything(),
		);
	});

	it("leaves due content untouched while media usage activation is incomplete", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		await db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		const runtime = buildRuntime(db);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runtime.publishScheduled()).rejects.toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				status: 503,
			});

			await expect(runtime.runScheduledTasks()).resolves.toEqual({ published: [] });
			const unchanged = await repo.findById("post", post.id);
			expect(unchanged?.status).toBe("scheduled");
			expect(unchanged?.scheduledAt).toBe(past);
		} finally {
			consoleError.mockRestore();
		}
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
		vi.restoreAllMocks();
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

	it("allows only one publisher prepared from the same scheduled snapshot", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		const revisionRepo = new RevisionRepository(db);
		const originalFind = RevisionRepository.prototype.findById;
		let releaseFirst!: () => void;
		let markFirstReady!: () => void;
		const firstReady = new Promise<void>((resolve) => {
			markFirstReady = resolve;
		});
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstCall = true;
		const find = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockImplementation(async function (revisionId) {
				const revision = await originalFind.call(this, revisionId);
				if (firstCall) {
					firstCall = false;
					markFirstReady();
					await firstBlocked;
				}
				return revision;
			});

		const firstResult = repo
			.publish("post", post.id, undefined, true, past)
			.catch((error: unknown) => error);
		await firstReady;
		const second = await repo.publish("post", post.id, undefined, true, past);
		releaseFirst();

		expect(second.status).toBe("published");
		expect(await firstResult).toBeInstanceOf(ScheduledNotDueError);
		expect(await revisionRepo.countByEntry("post", post.id)).toBe(1);
		find.mockRestore();
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

	it("rejects a schedule changed after sweep selection even when the new time is also due", async () => {
		const post = await repo.create(createPostFixture());
		const selectedSchedule = new Date(Date.now() - 120_000).toISOString();
		const replacementSchedule = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, {
			status: "scheduled",
			scheduledAt: selectedSchedule,
		});
		await repo.update("post", post.id, { scheduledAt: replacementSchedule });

		await expect(
			repo.publish("post", post.id, selectedSchedule, true, selectedSchedule),
		).rejects.toBeInstanceOf(ScheduledNotDueError);

		const after = await repo.findById("post", post.id);
		expect(after?.scheduledAt).toBe(replacementSchedule);
		expect(after?.status).toBe("scheduled");
	});

	it("rejects publication when a draft swap wins during revision preparation", async () => {
		const post = await repo.create(createPostFixture());
		const revisionRepo = new RevisionRepository(db);
		const firstDraft = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "First draft" },
		});
		await repo.setDraftRevision("post", post.id, firstDraft.id);
		const expected = await repo.findById("post", post.id);
		expect(expected).not.toBeNull();

		const originalFind = RevisionRepository.prototype.findById;
		let releasePublish!: () => void;
		let markPublishReady!: () => void;
		const publishReady = new Promise<void>((resolve) => {
			markPublishReady = resolve;
		});
		const publishBlocked = new Promise<void>((resolve) => {
			releasePublish = resolve;
		});
		const find = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockImplementationOnce(async function (revisionId) {
				const revision = await originalFind.call(this, revisionId);
				markPublishReady();
				await publishBlocked;
				return revision;
			});

		const publishResult = repo.publish("post", post.id).catch((error: unknown) => error);
		await publishReady;
		const replacement = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Replacement draft" },
		});
		expect(await repo.replaceDraftRevision("post", post.id, replacement.id, expected!)).toBe(true);
		releasePublish();

		expect(await publishResult).toBeInstanceOf(ContentMutationConflictError);
		const after = await repo.findById("post", post.id);
		expect(after?.status).toBe("draft");
		expect(after?.liveRevisionId).toBeNull();
		expect(after?.draftRevisionId).toBe(replacement.id);
		find.mockRestore();
	});

	it("rejects a stale draft swap after publication wins", async () => {
		const post = await repo.create(createPostFixture());
		const revisionRepo = new RevisionRepository(db);
		const staged = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Published draft" },
		});
		await repo.setDraftRevision("post", post.id, staged.id);
		const expected = await repo.findById("post", post.id);
		expect(expected).not.toBeNull();
		const losingDraft = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Losing draft" },
		});

		const published = await repo.publish("post", post.id);
		const swapped = await repo.replaceDraftRevision("post", post.id, losingDraft.id, expected!);
		const cleaned = await revisionRepo.deleteIfUnreferenced("post", post.id, losingDraft.id);

		expect(swapped).toBe(false);
		expect(cleaned).toBe(true);
		expect(published.liveRevisionId).toBe(staged.id);
		expect(await revisionRepo.findById(losingDraft.id)).toBeNull();
	});

	it("does not publish when the entry is rescheduled during revision preparation", async () => {
		const post = await repo.create(createPostFixture());
		const revisionRepo = new RevisionRepository(db);
		const draft = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Prepared draft" },
		});
		await repo.setDraftRevision("post", post.id, draft.id);
		const past = new Date(Date.now() - 60_000).toISOString();
		const future = new Date(Date.now() + 86_400_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		const originalFind = RevisionRepository.prototype.findById;
		const find = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockImplementationOnce(async function (revisionId) {
				const revision = await originalFind.call(this, revisionId);
				await repo.update("post", post.id, { scheduledAt: future });
				return revision;
			});

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toBeInstanceOf(
			ScheduledNotDueError,
		);
		find.mockRestore();

		const after = await repo.findById("post", post.id);
		expect(after?.status).toBe("scheduled");
		expect(after?.scheduledAt).toBe(future);
		expect(after?.draftRevisionId).toBe(draft.id);
	});

	it("does not leak staged fields when the promotion statement fails", async () => {
		const post = await repo.create(createPostFixture({ slug: "initial-slug" }));
		const revisionRepo = new RevisionRepository(db);
		const draft = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Final title", _slug: "approved-slug" },
		});
		await repo.setDraftRevision("post", post.id, draft.id);
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });
		await sql`
			CREATE TRIGGER reject_test_publication
			BEFORE UPDATE OF status ON ec_post
			WHEN NEW.status = 'published'
			BEGIN
				SELECT RAISE(ABORT, 'test publication failure');
			END
		`.execute(db);

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toThrow(
			"test publication failure",
		);

		const after = await repo.findById("post", post.id);
		expect(after).toMatchObject({
			slug: "initial-slug",
			status: "scheduled",
			scheduledAt: past,
			draftRevisionId: draft.id,
		});
		expect(after?.data.title).toBe("Hello World");
	});

	it("leaves a scheduled draft unchanged when publication preparation fails", async () => {
		const post = await repo.create(createPostFixture());
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

		const before = await repo.findById("post", post.id);
		const beforeUpdatedAt = before?.updatedAt;

		const spy = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockRejectedValueOnce(new Error("boom"));

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toThrow("boom");
		spy.mockRestore();

		const after = await repo.findById("post", post.id);
		expect(after?.scheduledAt).toBe(past);
		expect(after?.status).toBe("scheduled");
		expect(after?.updatedAt).toBe(beforeUpdatedAt);
	});

	it("leaves a published replacement schedule unchanged when preparation fails", async () => {
		const post = await repo.create(createPostFixture());
		await repo.publish("post", post.id);
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", post.id, { scheduledAt: past });

		const spy = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockRejectedValueOnce(new Error("boom"));

		await expect(repo.publish("post", post.id, undefined, true)).rejects.toThrow("boom");
		spy.mockRestore();

		const after = await repo.findById("post", post.id);
		expect(after?.scheduledAt).toBe(past);
		expect(after?.status).toBe("published");
	});

	it("ignores the gate when requireDue is false (manual publish path)", async () => {
		const post = await repo.create(createPostFixture());
		// Plain draft, never scheduled.
		const result = await repo.publish("post", post.id);
		expect(result.status).toBe("published");
	});

	it("maps a lost manual publication CAS to CONFLICT", async () => {
		const post = await repo.create(createPostFixture());
		vi.spyOn(ContentRepository.prototype, "publish").mockRejectedValueOnce(
			new ContentMutationConflictError(),
		);

		const result = await handleContentPublish(db, "post", post.id);

		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});
});
