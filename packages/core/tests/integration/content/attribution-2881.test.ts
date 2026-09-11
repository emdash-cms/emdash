/**
 * Content attribution keeps the acting user separate from entry ownership.
 * Authenticated revisions and save hooks receive the actor, while owner
 * changes affect only the content row.
 */

import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import type { ContentBeforeSaveHandler, ContentHookEvent } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const deferred: Array<() => void | Promise<void>> = [];

vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));

const actorA = { id: "user_a", role: Role.AUTHOR };
const actorB = { id: "user_b", role: Role.EDITOR };

async function flushDeferred(): Promise<void> {
	const tasks = deferred.splice(0);
	for (const task of tasks) await task();
}

async function createPostCollection(registry: SchemaRegistry): Promise<void> {
	await registry.createCollection({ slug: "posts", label: "Posts" });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
}

describe("revision attribution", () => {
	let db: ReturnType<typeof setupTestDatabase> extends Promise<infer T> ? T : never;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		deferred.length = 0;
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await createPostCollection(registry);
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("attributes a draft revision to the acting user, not NULL", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Draft" },
			slug: "draft-post",
			authorId: "owner_1",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft edited" },
			actor: actorA,
		});
		expect(saved.success).toBe(true);

		const revisionRepo = new RevisionRepository(db);
		const latest = await revisionRepo.findLatest("posts", id);
		expect(latest?.authorId).toBe(actorA.id);
	});

	it("does not reassign entry ownership when only a revision author is supplied", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Owned" },
			slug: "owned-post",
			authorId: "owner_1",
		});
		const id = created.data!.item.id;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Owned edited" },
			actor: actorA,
		});
		expect(saved.success).toBe(true);
		expect(saved.success && saved.liveContentChanged).toBe(false);

		const repo = new ContentRepository(db);
		const item = await repo.findById("posts", id);
		expect(item?.authorId).toBe("owner_1");
	});

	it("allows explicit ownership changes without conflating revision author", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Explicit" },
			slug: "explicit-post",
			authorId: "owner_1",
		});
		const id = created.data!.item.id;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Explicit edited" },
			authorId: "owner_2",
			actor: actorB,
		});
		expect(saved.success).toBe(true);

		const repo = new ContentRepository(db);
		const item = await repo.findById("posts", id);
		expect(item?.authorId).toBe("owner_2");

		const revisionRepo = new RevisionRepository(db);
		const latest = await revisionRepo.findLatest("posts", id);
		expect(latest?.authorId).toBe(actorB.id);
	});

	it("does not attribute an actorless revision to a new owner", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Explicit" },
			slug: "actorless-owner-change",
			authorId: "owner_1",
		});
		const id = created.data!.item.id;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Explicit edited" },
			authorId: "owner_2",
		});
		expect(saved.success).toBe(true);

		const item = await new ContentRepository(db).findById("posts", id);
		expect(item?.authorId).toBe("owner_2");

		const latest = await new RevisionRepository(db).findLatest("posts", id);
		expect(latest?.authorId).toBeNull();
	});
});

describe("hook actor payloads", () => {
	const beforeEvents: ContentHookEvent[] = [];
	const afterEvents: ContentHookEvent[] = [];
	let mutateBeforeSaveActor = false;

	let sqlite: Database.Database;
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	function createTrustedDeps(): RuntimeDependencies {
		return {
			config: {
				database: {
					entrypoint: `test-actor-hooks-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			plugins: [
				definePlugin({
					id: "actor-probe",
					version: "1.0.0",
					capabilities: ["content:write", "content:read"],
					hooks: {
						"content:beforeSave": {
							handler: (async (event) => {
								const mutableActor = event.actor as { id: string; role: number } | undefined;
								if (mutateBeforeSaveActor && mutableActor) {
									mutableActor.id = "spoofed_by_hook";
								}
								beforeEvents.push(event);
							}) as ContentBeforeSaveHandler,
						},
						"content:afterSave": {
							handler: async (event) => {
								afterEvents.push(event);
							},
						},
					},
				}),
			],
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		};
	}

	beforeEach(async () => {
		deferred.length = 0;
		beforeEvents.length = 0;
		afterEvents.length = 0;
		mutateBeforeSaveActor = false;
		sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create(createTrustedDeps());
		const registry = new SchemaRegistry(runtime.db);
		await createPostCollection(registry);
		repo = new ContentRepository(runtime.db);
	});

	afterEach(async () => {
		await runtime.stopCron();
		vi.restoreAllMocks();
	});

	it("passes actor to content:beforeSave / content:afterSave on create", async () => {
		const result = await runtime.handleContentCreate("posts", {
			data: { title: "Created" },
			actor: actorA,
		});
		expect(result.success).toBe(true);

		expect(beforeEvents).toHaveLength(1);
		expect(beforeEvents[0]).toMatchObject({
			collection: "posts",
			isNew: true,
			actor: actorA,
		});
		expect(beforeEvents[0]?.id).toBeUndefined();

		await flushDeferred();

		expect(afterEvents).toHaveLength(1);
		expect(afterEvents[0]).toMatchObject({
			collection: "posts",
			isNew: true,
			actor: actorA,
		});
		expect(afterEvents[0]?.content.id).toBe(result.data?.item.id);
	});

	it("passes actor and item id to content:beforeSave / content:afterSave on update", async () => {
		const item = await repo.create({ type: "posts", data: { title: "Original" } });

		const result = await runtime.handleContentUpdate("posts", item.id, {
			data: { title: "Changed" },
			actor: actorB,
		});
		expect(result.success).toBe(true);

		expect(beforeEvents).toEqual([
			{
				content: { title: "Changed" },
				collection: "posts",
				isNew: false,
				id: item.id,
				actor: actorB,
			},
		]);

		await flushDeferred();

		expect(afterEvents).toHaveLength(1);
		expect(afterEvents[0]).toMatchObject({
			collection: "posts",
			isNew: false,
			actor: actorB,
		});
		expect(afterEvents[0]?.content.id).toBe(item.id);
	});

	it("keeps revision and downstream hook attribution stable when a hook mutates its event", async () => {
		const item = await repo.create({ type: "posts", data: { title: "Original" } });
		const actor = { id: "authenticated_user", role: Role.EDITOR };
		mutateBeforeSaveActor = true;

		const result = await runtime.handleContentUpdate("posts", item.id, {
			data: { title: "Changed" },
			actor,
		});
		expect(result.success).toBe(true);

		const latest = await new RevisionRepository(runtime.db).findLatest("posts", item.id);
		expect(beforeEvents[0]?.actor?.id).toBe("spoofed_by_hook");
		expect(latest?.authorId).toBe("authenticated_user");
		expect(actor.id).toBe("authenticated_user");

		await flushDeferred();
		expect(afterEvents[0]?.actor).toEqual(actor);
	});
});

describe("sandboxed hook actor payloads", () => {
	const invokeHook = vi.fn<SandboxedPluginInstance["invokeHook"]>();

	let sqlite: Database.Database;
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	function createSandboxedDeps(): RuntimeDependencies {
		const runner = {
			isAvailable: () => true,
			isHealthy: () => true,
			load: vi.fn().mockResolvedValue({
				id: "actor-sandboxed:1.0.0",
				invokeHook,
				invokeRoute: vi.fn(),
				terminate: vi.fn(),
			}),
			setEmailSend: vi.fn(),
			terminateAll: vi.fn(),
		};
		return {
			config: {
				database: {
					entrypoint: `test-sandboxed-actor-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [
				{
					id: "actor-sandboxed",
					version: "1.0.0",
					options: {},
					code: "",
					capabilities: ["content:read", "content:write"],
					allowedHosts: [],
					storage: {},
				},
			],
			createSandboxRunner: (() => runner) as unknown as RuntimeDependencies["createSandboxRunner"],
		};
	}

	beforeEach(async () => {
		invokeHook.mockReset();
		invokeHook.mockResolvedValue(undefined);
		sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create(createSandboxedDeps());
		const registry = new SchemaRegistry(runtime.db);
		await createPostCollection(registry);
		repo = new ContentRepository(runtime.db);
	});

	afterEach(async () => {
		await runtime.stopCron();
		vi.restoreAllMocks();
	});

	it("passes actor to sandboxed content:beforeSave on create", async () => {
		const result = await runtime.handleContentCreate("posts", {
			data: { title: "Sandbox create" },
			actor: actorA,
		});
		expect(result.success).toBe(true);

		expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
			content: { title: "Sandbox create" },
			collection: "posts",
			isNew: true,
			actor: actorA,
		});
	});

	it("passes actor and id to sandboxed content:beforeSave on update", async () => {
		const item = await repo.create({ type: "posts", data: { title: "Original" } });

		const result = await runtime.handleContentUpdate("posts", item.id, {
			data: { title: "Changed" },
			actor: actorB,
		});
		expect(result.success).toBe(true);

		expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
			content: { title: "Changed" },
			collection: "posts",
			isNew: false,
			id: item.id,
			actor: actorB,
		});
	});
});
