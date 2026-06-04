/**
 * HookPipeline Tests
 *
 * Tests the v2 hook pipeline for:
 * - Hook registration and sorting
 * - Hook execution with timeout
 * - Content hooks (beforeSave, afterSave, beforeDelete, afterDelete)
 * - Lifecycle hooks (install, activate, deactivate, uninstall)
 * - Error handling and error policies
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Database as DbSchema } from "../../../src/database/types.js";
import { HookPipeline, createHookPipeline } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin, ResolvedHook, ContentHookEvent } from "../../../src/plugins/types.js";

/**
 * Create a minimal resolved plugin for testing
 */
function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: {
			pages: [],
			widgets: [],
		},
		hooks: {},
		routes: {},
		...overrides,
	};
}

/**
 * Create a resolved hook with defaults
 */
function createTestHook<T>(
	pluginId: string,
	handler: T,
	overrides: Partial<ResolvedHook<T>> = {},
): ResolvedHook<T> {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		...overrides,
	};
}

describe("HookPipeline", () => {
	// A real in-memory DB is needed for the context factory so hooks can
	// actually execute (getContext throws without one).
	let db: Kysely<DbSchema>;

	beforeEach(() => {
		const sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqliteDb }) });
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("construction and registration", () => {
		it("creates empty pipeline with no plugins", () => {
			const pipeline = new HookPipeline([]);

			expect(pipeline.hasHooks("content:beforeSave")).toBe(false);
			expect(pipeline.getHookCount("content:beforeSave")).toBe(0);
		});

		it("registers hooks from plugins", () => {
			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["content:write", "content:read"],
				hooks: {
					"content:beforeSave": createTestHook("test", vi.fn()),
					"content:afterSave": createTestHook("test", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);

			expect(pipeline.hasHooks("content:beforeSave")).toBe(true);
			expect(pipeline.hasHooks("content:afterSave")).toBe(true);
			expect(pipeline.hasHooks("content:beforeDelete")).toBe(false);
		});

		it("tracks registered hook names", () => {
			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["content:write", "media:read"],
				hooks: {
					"content:beforeSave": createTestHook("test", vi.fn()),
					"media:afterUpload": createTestHook("test", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			const registered = pipeline.getRegisteredHooks();

			expect(registered).toContain("content:beforeSave");
			expect(registered).toContain("media:afterUpload");
			expect(registered).not.toContain("content:afterSave");
		});
	});

	describe("hook sorting", () => {
		it("executes hooks in priority order (lower priority first)", async () => {
			const order: string[] = [];
			const make = (id: string, priority: number) =>
				createTestPlugin({
					id,
					capabilities: ["content:write"],
					hooks: {
						"content:beforeSave": createTestHook(
							id,
							async (event: ContentHookEvent) => {
								order.push(id);
								return event.content;
							},
							{ priority },
						),
					},
				});

			// Registered out of priority order on purpose.
			const pipeline = new HookPipeline(
				[make("plugin-200", 200), make("plugin-50", 50), make("plugin-100", 100)],
				{ db },
			);

			await pipeline.runContentBeforeSave({ title: "hi" }, "posts", true);

			expect(order).toEqual(["plugin-50", "plugin-100", "plugin-200"]);
		});

		it("runs a dependency before the dependent hook despite lower priority", async () => {
			const order: string[] = [];

			const dependent = createTestPlugin({
				id: "dependent",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook(
						"dependent",
						async (event: ContentHookEvent) => {
							order.push("dependent");
							return event.content;
						},
						{ priority: 50, dependencies: ["dependency"] },
					),
				},
			});

			const dependency = createTestPlugin({
				id: "dependency",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook(
						"dependency",
						async (event: ContentHookEvent) => {
							order.push("dependency");
							return event.content;
						},
						{ priority: 100 },
					),
				},
			});

			const pipeline = new HookPipeline([dependent, dependency], { db });

			await pipeline.runContentBeforeSave({ title: "hi" }, "posts", true);

			// "dependency" must run first even though "dependent" has the lower priority.
			expect(order).toEqual(["dependency", "dependent"]);
		});
	});

	describe("content:beforeSave", () => {
		it("runs the hook and returns modified content", async () => {
			const handler = vi.fn(async (event: ContentHookEvent) => ({
				...event.content,
				modified: true,
			}));

			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin], { db });

			const { content } = await pipeline.runContentBeforeSave({ title: "Hello" }, "posts", true);

			expect(handler).toHaveBeenCalledOnce();
			expect(content).toEqual({ title: "Hello", modified: true });
		});

		it("chains content through multiple hooks in priority order", async () => {
			const handler1 = vi.fn(async (event: ContentHookEvent) => ({
				...event.content,
				step1: true,
			}));
			const handler2 = vi.fn(async (event: ContentHookEvent) => ({
				...event.content,
				step2: true,
			}));

			const plugin1 = createTestPlugin({
				id: "plugin-1",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook("plugin-1", handler1, { priority: 1 }),
				},
			});

			const plugin2 = createTestPlugin({
				id: "plugin-2",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook("plugin-2", handler2, { priority: 2 }),
				},
			});

			const pipeline = new HookPipeline([plugin1, plugin2], { db });

			const { content } = await pipeline.runContentBeforeSave({ title: "x" }, "posts", true);

			// Both transformations land, and handler2 received handler1's output.
			expect(content).toEqual({ title: "x", step1: true, step2: true });
			expect(handler2.mock.calls[0]?.[0]?.content).toEqual({ title: "x", step1: true });
		});
	});

	describe("content:beforeDelete", () => {
		it("registers beforeDelete hooks", () => {
			const handler = vi.fn(async () => true);

			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["content:read"],
				hooks: {
					"content:beforeDelete": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeDelete")).toBe(true);
		});
	});

	describe("lifecycle hooks", () => {
		it("registers plugin:install hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				hooks: {
					"plugin:install": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("plugin:install")).toBe(true);
		});

		it("registers plugin:activate hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				hooks: {
					"plugin:activate": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("plugin:activate")).toBe(true);
		});

		it("registers plugin:deactivate hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				hooks: {
					"plugin:deactivate": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("plugin:deactivate")).toBe(true);
		});

		it("registers plugin:uninstall hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				hooks: {
					"plugin:uninstall": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("plugin:uninstall")).toBe(true);
		});
	});

	describe("media hooks", () => {
		it("registers media:beforeUpload hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["media:write"],
				hooks: {
					"media:beforeUpload": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:beforeUpload")).toBe(true);
		});

		it("registers media:afterUpload hook", () => {
			const handler = vi.fn();

			const plugin = createTestPlugin({
				id: "test",
				capabilities: ["media:read"],
				hooks: {
					"media:afterUpload": createTestHook("test", handler),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:afterUpload")).toBe(true);
		});
	});

	describe("createHookPipeline helper", () => {
		it("creates a HookPipeline instance", () => {
			const plugins = [createTestPlugin({ id: "test" })];
			const pipeline = createHookPipeline(plugins);

			expect(pipeline).toBeInstanceOf(HookPipeline);
		});
	});

	// =========================================================================
	// Capability enforcement for non-email hooks
	// =========================================================================

	describe("capability enforcement — content hooks", () => {
		it("skips content:beforeSave without content:write capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:beforeSave": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeSave")).toBe(false);
		});

		it("skips content:beforeSave with only content:read (requires content:write)", () => {
			const plugin = createTestPlugin({
				id: "read-only",
				capabilities: ["content:read"],
				hooks: {
					"content:beforeSave": createTestHook("read-only", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeSave")).toBe(false);
		});

		it("registers content:beforeSave with content:write capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["content:write"],
				hooks: {
					"content:beforeSave": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeSave")).toBe(true);
		});

		it("skips content:afterSave without content:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:afterSave": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterSave")).toBe(false);
		});

		it("registers content:afterSave with content:read capability (read-only notification)", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["content:read"],
				hooks: {
					"content:afterSave": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterSave")).toBe(true);
		});

		it("skips content:beforeDelete without content:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:beforeDelete": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeDelete")).toBe(false);
		});

		it("skips content:afterDelete without content:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:afterDelete": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterDelete")).toBe(false);
		});

		it("registers all content hooks with content:write + content:read", () => {
			const plugin = createTestPlugin({
				id: "writer",
				capabilities: ["content:write", "content:read"],
				hooks: {
					"content:beforeSave": createTestHook("writer", vi.fn()),
					"content:afterSave": createTestHook("writer", vi.fn()),
					"content:beforeDelete": createTestHook("writer", vi.fn()),
					"content:afterDelete": createTestHook("writer", vi.fn()),
					"content:afterPublish": createTestHook("writer", vi.fn()),
					"content:afterUnpublish": createTestHook("writer", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:beforeSave")).toBe(true);
			expect(pipeline.hasHooks("content:afterSave")).toBe(true);
			expect(pipeline.hasHooks("content:beforeDelete")).toBe(true);
			expect(pipeline.hasHooks("content:afterDelete")).toBe(true);
			expect(pipeline.hasHooks("content:afterPublish")).toBe(true);
			expect(pipeline.hasHooks("content:afterUnpublish")).toBe(true);
		});

		it("skips content:afterPublish without content:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:afterPublish": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterPublish")).toBe(false);
		});

		it("registers content:afterPublish with content:read capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["content:read"],
				hooks: {
					"content:afterPublish": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterPublish")).toBe(true);
		});

		it("skips content:afterUnpublish without content:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"content:afterUnpublish": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterUnpublish")).toBe(false);
		});

		it("registers content:afterUnpublish with content:read capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["content:read"],
				hooks: {
					"content:afterUnpublish": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("content:afterUnpublish")).toBe(true);
		});
	});

	describe("capability enforcement — media hooks", () => {
		it("skips media:beforeUpload without media:write capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"media:beforeUpload": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:beforeUpload")).toBe(false);
		});

		it("registers media:beforeUpload with media:write capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["media:write"],
				hooks: {
					"media:beforeUpload": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:beforeUpload")).toBe(true);
		});

		it("skips media:afterUpload without media:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"media:afterUpload": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:afterUpload")).toBe(false);
		});

		it("registers media:afterUpload with media:read capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["media:read"],
				hooks: {
					"media:afterUpload": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("media:afterUpload")).toBe(true);
		});
	});

	describe("capability enforcement — comment hooks", () => {
		it("skips comment:beforeCreate without users:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"comment:beforeCreate": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("comment:beforeCreate")).toBe(false);
		});

		it("registers comment:beforeCreate with users:read capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["users:read"],
				hooks: {
					"comment:beforeCreate": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("comment:beforeCreate")).toBe(true);
		});

		it("skips comment:moderate without users:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"comment:moderate": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("comment:moderate")).toBe(false);
		});

		it("skips comment:afterCreate without users:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"comment:afterCreate": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("comment:afterCreate")).toBe(false);
		});

		it("skips comment:afterModerate without users:read capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"comment:afterModerate": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("comment:afterModerate")).toBe(false);
		});
	});

	describe("capability enforcement — page:fragments", () => {
		it("skips page:fragments without hooks.page-fragments:register capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"page:fragments": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("page:fragments")).toBe(false);
		});

		it("registers page:fragments with hooks.page-fragments:register capability", () => {
			const plugin = createTestPlugin({
				id: "has-cap",
				capabilities: ["hooks.page-fragments:register"],
				hooks: {
					"page:fragments": createTestHook("has-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("page:fragments")).toBe(true);
		});
	});

	describe("capability enforcement — hooks without requirements", () => {
		it("registers lifecycle hooks without any capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"plugin:install": createTestHook("no-cap", vi.fn()),
					"plugin:activate": createTestHook("no-cap", vi.fn()),
					"plugin:deactivate": createTestHook("no-cap", vi.fn()),
					"plugin:uninstall": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("plugin:install")).toBe(true);
			expect(pipeline.hasHooks("plugin:activate")).toBe(true);
			expect(pipeline.hasHooks("plugin:deactivate")).toBe(true);
			expect(pipeline.hasHooks("plugin:uninstall")).toBe(true);
		});

		it("registers cron hook without any capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					cron: createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("cron")).toBe(true);
		});

		it("registers page:metadata without any capability", () => {
			const plugin = createTestPlugin({
				id: "no-cap",
				capabilities: [],
				hooks: {
					"page:metadata": createTestHook("no-cap", vi.fn()),
				},
			});

			const pipeline = new HookPipeline([plugin]);
			expect(pipeline.hasHooks("page:metadata")).toBe(true);
		});
	});
});
