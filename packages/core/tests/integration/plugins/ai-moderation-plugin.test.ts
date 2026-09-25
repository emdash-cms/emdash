/**
 * Boots a runtime with the plugin as a site that lists `aiModerationPlugin()`
 * does; the hook pipeline drops hooks its declared capabilities do not cover.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlugin } from "../../../../plugins/ai-moderation/src/index.js";
import { DEFAULT_COMMENT_MODERATOR_PLUGIN_ID } from "../../../src/comments/moderator.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { CollectionCommentSettings } from "../../../src/plugins/types.js";

const aiRun = vi.hoisted(() => vi.fn());

// The plugin reaches Workers AI through the `cloudflare:workers` env binding,
// which does not exist under Node.
vi.mock("cloudflare:workers", () => ({ env: { AI: { run: aiRun } } }));

const settings: CollectionCommentSettings = {
	commentsEnabled: true,
	commentsModeration: "first_time",
	commentsClosedAfterDays: 90,
	commentsAutoApproveUsers: true,
};

const spamComment = {
	collection: "post",
	contentId: "post-1",
	authorName: "Visitor",
	authorEmail: "visitor@example.com",
	body: "Buy cheap pills at example.com",
};

describe("ai-moderation plugin", () => {
	const runtimes: EmDashRuntime[] = [];

	async function boot(
		sqlite = new Database(":memory:"),
		plugins = [createPlugin()],
	): Promise<EmDashRuntime> {
		const runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: `test-ai-moderation-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			plugins,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
		runtimes.push(runtime);
		return runtime;
	}

	beforeEach(() => {
		aiRun.mockReset();
		aiRun.mockResolvedValue({ response: "unsafe\nC1" });
	});

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.shutdown();
	});

	it("registers its comment hooks", async () => {
		const { hooks } = await boot();

		expect(hooks.getHookProviders("comment:beforeCreate")).toContainEqual({
			pluginId: "ai-moderation",
		});
		expect(hooks.getExclusiveHookProviders("comment:moderate")).toContainEqual({
			pluginId: "ai-moderation",
		});
	});

	it("moderates comments in place of the built-in moderator on a new site", async () => {
		const site = await boot();

		const result = await site.handleCommentCreate(spamComment, settings);

		expect(aiRun).toHaveBeenCalledOnce();
		expect(result?.decision).toEqual({ status: "spam", reason: "AI flagged: C1" });
		expect(result?.comment.status).toBe("spam");
		expect(site.hooks.getExclusiveSelection("comment:moderate")).toBe("ai-moderation");
	});

	it("takes over on a site that started without a moderation plugin", async () => {
		const sqlite = new Database(":memory:");
		const firstSite = await boot(sqlite, []);
		await firstSite.shutdown();
		const site = await boot(sqlite);

		const result = await site.handleCommentCreate(spamComment, settings);

		expect(result?.decision).toEqual({ status: "spam", reason: "AI flagged: C1" });
		expect(site.hooks.getExclusiveSelection("comment:moderate")).toBe("ai-moderation");
	});

	it("takes over again when it is disabled and enabled", async () => {
		const site = await boot();

		await site.handlePluginDisable("ai-moderation");
		expect(site.hooks.getExclusiveSelection("comment:moderate")).toBe(
			DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
		);
		await site.handlePluginEnable("ai-moderation");

		const result = await site.handleCommentCreate(spamComment, settings);

		expect(result?.decision).toEqual({ status: "spam", reason: "AI flagged: C1" });
		expect(site.hooks.getExclusiveSelection("comment:moderate")).toBe("ai-moderation");
	});

	it("keeps a stored choice of the built-in moderator", async () => {
		const sqlite = new Database(":memory:");
		const setupDb = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(setupDb);
		await new OptionsRepository(setupDb).set(
			"emdash:exclusive_hook:comment:moderate",
			DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
		);
		const site = await boot(sqlite);

		const result = await site.handleCommentCreate(spamComment, settings);

		expect(site.hooks.getExclusiveSelection("comment:moderate")).toBe(
			DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
		);
		expect(result?.decision).toEqual({ status: "pending", reason: "Held for review" });
		expect(result?.comment.moderationMetadata).toEqual({
			aiGuard: { safe: false, categories: ["C1"] },
		});
	});
});
