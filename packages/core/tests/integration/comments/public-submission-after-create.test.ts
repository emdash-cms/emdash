import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { submitPublicComment } from "../../../src/comments/public-submission.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { CommentAfterCreateEvent } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const { deferredTasks } = vi.hoisted(() => ({
	deferredTasks: [] as Array<() => void | Promise<void>>,
}));

// Capture work handed to `after()` instead of running it, so the test can tell
// deferred hooks (kept alive by the host's waitUntil) from fire-and-forget ones.
vi.mock("../../../src/after.js", () => ({
	after: vi.fn((fn: () => void | Promise<void>) => {
		deferredTasks.push(fn);
	}),
}));

describe("submitPublicComment comment:afterCreate", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await new SchemaRegistry(db).updateCollection("post", { commentsEnabled: true });
		await new ContentRepository(db).create({
			id: "post-1",
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
		deferredTasks.length = 0;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("runs afterCreate hooks through after() so the host keeps them alive", async () => {
		const afterCreate = vi.fn(async (_event: CommentAfterCreateEvent) => {});
		const plugin = definePlugin({
			id: "test-notifier",
			version: "1.0.0",
			capabilities: ["users:read"],
			hooks: { "comment:afterCreate": afterCreate },
		});
		const hooks = createHookPipeline([plugin], { db });

		const response = await submitPublicComment(
			{ db, config: {}, email: null, hooks },
			"post",
			"post-1",
			new Request("https://example.com/_emdash/api/comments/post/post-1", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					authorName: "Jane",
					authorEmail: "jane@example.com",
					body: "Great post!",
				}),
			}),
		);

		expect(response.status).toBe(201);
		// On Workers, anything not handed to waitUntil can be cancelled once the
		// response is returned, so the hook must be registered as deferred work.
		expect(afterCreate).not.toHaveBeenCalled();

		for (const task of deferredTasks.splice(0)) await task();

		expect(afterCreate).toHaveBeenCalledOnce();
		expect(afterCreate.mock.calls[0]![0]).toMatchObject({
			comment: { authorName: "Jane", status: "pending" },
			content: { id: "post-1", collection: "post", slug: "hello" },
		});
	});
});
