import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { createHookPipeline } from "../../src/plugins/hooks.js";
import { publishDueContent } from "../../src/scheduled-publish.js";
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
