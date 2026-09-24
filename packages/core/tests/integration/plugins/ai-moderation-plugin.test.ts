/**
 * Boots a runtime with the plugin as a site that lists `aiModerationPlugin()`
 * does; the hook pipeline drops hooks its declared capabilities do not cover.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createPlugin } from "../../../../plugins/ai-moderation/src/index.js";
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

describe("ai-moderation plugin", () => {
	let runtime: EmDashRuntime;
	let warn: MockInstance<typeof console.warn>;

	beforeEach(async () => {
		aiRun.mockReset();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: `test-ai-moderation-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			plugins: [createPlugin()],
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
	});

	afterEach(async () => {
		warn.mockRestore();
		await runtime?.stopCron();
	});

	it("boots without skipping its comment hooks", () => {
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("skipping"));
		expect(runtime.hooks.getExclusiveHookProviders("comment:moderate")).toContainEqual({
			pluginId: "ai-moderation",
		});
	});

	it("marks a comment as spam when Workers AI flags a blocking category", async () => {
		aiRun.mockResolvedValue({ response: "unsafe\nC1" });
		// The built-in moderator also provides comment:moderate, so the site
		// has to select the plugin, as the exclusive-hooks admin endpoint does.
		runtime.hooks.setExclusiveSelection("comment:moderate", "ai-moderation");

		const result = await runtime.handleCommentCreate(
			{
				collection: "post",
				contentId: "post-1",
				authorName: "Visitor",
				authorEmail: "visitor@example.com",
				body: "Buy cheap pills at example.com",
			},
			settings,
		);

		expect(aiRun).toHaveBeenCalledOnce();
		expect(result?.decision).toEqual({ status: "spam", reason: "AI flagged: C1" });
		expect(result?.comment.status).toBe("spam");
	});
});
