import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import type { ContentBeforeSaveHandler, ContentHookEvent } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

function baseDeps(
	sqlite: Database.Database,
): Pick<RuntimeDependencies, "config" | "createDialect" | "createStorage"> {
	return {
		config: {
			database: {
				entrypoint: `test-before-save-event-id-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
	};
}

function trustedDeps(
	sqlite: Database.Database,
	handler: ContentBeforeSaveHandler,
): RuntimeDependencies {
	return {
		...baseDeps(sqlite),
		plugins: [
			definePlugin({
				id: "before-save-probe",
				version: "1.0.0",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": { handler },
				},
			}),
		],
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

function sandboxedDeps(
	sqlite: Database.Database,
	invokeHook: SandboxedPluginInstance["invokeHook"],
): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({
			id: "before-save-probe:1.0.0",
			invokeHook,
			invokeRoute: vi.fn(),
			terminate: vi.fn(),
		}),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	return {
		...baseDeps(sqlite),
		plugins: [],
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: "before-save-probe",
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: ["content:read", "content:write"],
				allowedHosts: [],
				storage: {},
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake implements the published runner boundary without platform setup
		createSandboxRunner: (() => runner) as any,
	};
}

async function createPostCollection(runtime: EmDashRuntime): Promise<ContentRepository> {
	const registry = new SchemaRegistry(runtime.db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	return new ContentRepository(runtime.db);
}

describe("content:beforeSave event id", () => {
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	afterEach(async () => {
		await runtime?.stopCron();
	});

	describe("trusted plugins", () => {
		const events: ContentHookEvent[] = [];

		beforeEach(async () => {
			events.length = 0;
			runtime = await EmDashRuntime.create(
				trustedDeps(new Database(":memory:"), async (event) => {
					events.push(event);
				}),
			);
			repo = await createPostCollection(runtime);
		});

		it("omits id when creating content", async () => {
			const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });

			expect(result.success).toBe(true);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ collection: "post", isNew: true });
			expect(events[0]?.id).toBeUndefined();
		});

		it("passes the item id when updating by id", async () => {
			const item = await repo.create({ type: "post", data: { title: "Original" } });

			const result = await runtime.handleContentUpdate("post", item.id, {
				data: { title: "Changed" },
			});

			expect(result.success).toBe(true);
			expect(events).toEqual([
				{ content: { title: "Changed" }, collection: "post", isNew: false, id: item.id },
			]);
		});

		it("passes the resolved item id when updating by slug", async () => {
			const item = await repo.create({
				type: "post",
				slug: "hello-world",
				data: { title: "Original" },
			});

			const result = await runtime.handleContentUpdate("post", "hello-world", {
				data: { title: "Changed" },
			});

			expect(result.success).toBe(true);
			expect(events).toHaveLength(1);
			expect(events[0]?.id).toBe(item.id);
		});
	});

	describe("sandboxed plugins", () => {
		const invokeHook = vi.fn<SandboxedPluginInstance["invokeHook"]>();

		beforeEach(async () => {
			invokeHook.mockReset();
			invokeHook.mockResolvedValue(undefined);
			runtime = await EmDashRuntime.create(sandboxedDeps(new Database(":memory:"), invokeHook));
			repo = await createPostCollection(runtime);
		});

		it("omits id when creating content", async () => {
			const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });

			expect(result.success).toBe(true);
			expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
				content: { title: "Hi" },
				collection: "post",
				isNew: true,
			});
		});

		it("passes the item id when updating", async () => {
			const item = await repo.create({ type: "post", data: { title: "Original" } });

			const result = await runtime.handleContentUpdate("post", item.id, {
				data: { title: "Changed" },
			});

			expect(result.success).toBe(true);
			expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
				content: { title: "Changed" },
				collection: "post",
				isNew: false,
				id: item.id,
			});
		});

		it("passes the resolved item id when updating by slug", async () => {
			const item = await repo.create({
				type: "post",
				slug: "hello-world",
				data: { title: "Original" },
			});

			const result = await runtime.handleContentUpdate("post", "hello-world", {
				data: { title: "Changed" },
			});

			expect(result.success).toBe(true);
			expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
				content: { title: "Changed" },
				collection: "post",
				isNew: false,
				id: item.id,
			});
		});
	});
});
