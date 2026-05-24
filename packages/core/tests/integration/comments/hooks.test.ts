import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultCommentModerate } from "../../../src/comments/moderator.js";
import {
	createComment,
	moderateComment,
	type CommentHookRunner,
} from "../../../src/comments/service.js";
import type { Database } from "../../../src/database/types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline, resolveExclusiveHooks } from "../../../src/plugins/hooks.js";
import type {
	CollectionCommentSettings,
	CommentBeforeCreateEvent,
	CommentModerateEvent,
	ModerationDecision,
	PluginContext,
} from "../../../src/plugins/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSettings(
	overrides: Partial<CollectionCommentSettings> = {},
): CollectionCommentSettings {
	return {
		commentsEnabled: true,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		...overrides,
	};
}

const defaultInput = {
	collection: "post",
	contentId: "content-1",
	authorName: "Jane",
	authorEmail: "jane@example.com",
	body: "Great post!",
};

// ---------------------------------------------------------------------------
// Group 1: Service with mocked CommentHookRunner
// ---------------------------------------------------------------------------

describe("Comment Service with CommentHookRunner", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function makeHookRunner(overrides: Partial<CommentHookRunner> = {}): CommentHookRunner {
		return {
			runBeforeCreate: vi.fn(async (event: CommentBeforeCreateEvent) => event),
			runModerate: vi.fn(async () => ({
				status: "approved" as const,
				reason: "Test",
			})),
			fireAfterCreate: vi.fn(),
			fireAfterModerate: vi.fn(),
			...overrides,
		};
	}

	it("creates comment with status from runModerate", async () => {
		const hooks = makeHookRunner({
			runModerate: vi.fn(async () => ({ status: "pending" as const, reason: "Held" })),
		});

		const result = await createComment(db, defaultInput, defaultSettings(), hooks);

		expect(result).not.toBeNull();
		expect(result!.comment.status).toBe("pending");
		expect(result!.decision.status).toBe("pending");
	});

	it("transforms comment data via beforeCreate", async () => {
		const hooks = makeHookRunner({
			runBeforeCreate: vi.fn(async (event: CommentBeforeCreateEvent) => ({
				...event,
				comment: { ...event.comment, body: "Modified body" },
			})),
		});

		const result = await createComment(db, defaultInput, defaultSettings(), hooks);

		expect(result).not.toBeNull();
		expect(result!.comment.body).toBe("Modified body");
	});

	it("returns null when beforeCreate returns false (rejected)", async () => {
		const hooks = makeHookRunner({
			runBeforeCreate: vi.fn(async () => false as const),
		});

		const result = await createComment(db, defaultInput, defaultSettings(), hooks);

		expect(result).toBeNull();
	});

	it("saves as spam when runModerate returns spam", async () => {
		const hooks = makeHookRunner({
			runModerate: vi.fn(async () => ({ status: "spam" as const, reason: "Spam detected" })),
		});

		const result = await createComment(db, defaultInput, defaultSettings(), hooks);

		expect(result).not.toBeNull();
		expect(result!.comment.status).toBe("spam");
	});

	it("fires fireAfterCreate with correct shape", async () => {
		const hooks = makeHookRunner();

		await createComment(db, defaultInput, defaultSettings(), hooks, {
			id: "content-1",
			collection: "post",
			slug: "my-post",
			title: "My Post",
		});

		expect(hooks.fireAfterCreate).toHaveBeenCalledOnce();
		const event = (hooks.fireAfterCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(event.comment.collection).toBe("post");
		expect(event.comment.contentId).toBe("content-1");
		expect(event.content.slug).toBe("my-post");
	});

	it("moderateComment updates status and fires fireAfterModerate", async () => {
		const hooks = makeHookRunner();
		const created = await createComment(db, defaultInput, defaultSettings(), hooks);

		const updated = await moderateComment(
			db,
			created!.comment.id,
			"spam",
			{ id: "admin-1", name: "Admin" },
			hooks,
		);

		expect(updated).not.toBeNull();
		expect(updated!.status).toBe("spam");
		expect(hooks.fireAfterModerate).toHaveBeenCalledOnce();

		const event = (hooks.fireAfterModerate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(event.previousStatus).toBe("approved");
		expect(event.newStatus).toBe("spam");
		expect(event.moderator.id).toBe("admin-1");
	});

	it("moderateComment returns null for non-existent id", async () => {
		const hooks = makeHookRunner();

		const result = await moderateComment(
			db,
			"nonexistent",
			"approved",
			{ id: "admin-1", name: "Admin" },
			hooks,
		);

		expect(result).toBeNull();
		expect(hooks.fireAfterModerate).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Group 2: Built-in moderator unit tests
// ---------------------------------------------------------------------------

describe("Built-in Default Comment Moderator", () => {
	const ctx = {} as PluginContext;

	function makeModerateEvent(overrides: Partial<CommentModerateEvent> = {}): CommentModerateEvent {
		return {
			comment: {
				collection: "post",
				contentId: "c1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Hello",
				ipHash: null,
				userAgent: null,
			},
			metadata: {},
			collectionSettings: defaultSettings(),
			priorApprovedCount: 0,
			...overrides,
		};
	}

	it("auto-approves authenticated CMS users when configured", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				comment: {
					...makeModerateEvent().comment,
					authorUserId: "user-1",
				},
				collectionSettings: defaultSettings({ commentsAutoApproveUsers: true }),
			}),
			ctx,
		);

		expect(decision.status).toBe("approved");
		expect(decision.reason).toContain("Authenticated");
	});

	it("does not auto-approve when commentsAutoApproveUsers is false", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				comment: {
					...makeModerateEvent().comment,
					authorUserId: "user-1",
				},
				collectionSettings: defaultSettings({
					commentsAutoApproveUsers: false,
					commentsModeration: "all",
				}),
			}),
			ctx,
		);

		expect(decision.status).toBe("pending");
	});

	it("approves when moderation is 'none'", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				collectionSettings: defaultSettings({ commentsModeration: "none" }),
			}),
			ctx,
		);

		expect(decision.status).toBe("approved");
		expect(decision.reason).toContain("disabled");
	});

	it("approves returning commenter with first_time moderation", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				collectionSettings: defaultSettings({ commentsModeration: "first_time" }),
				priorApprovedCount: 3,
			}),
			ctx,
		);

		expect(decision.status).toBe("approved");
		expect(decision.reason).toContain("Returning");
	});

	it("holds new commenter with first_time moderation", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				collectionSettings: defaultSettings({ commentsModeration: "first_time" }),
				priorApprovedCount: 0,
			}),
			ctx,
		);

		expect(decision.status).toBe("pending");
	});

	it("holds all comments when moderation is 'all'", async () => {
		const decision = await defaultCommentModerate(
			makeModerateEvent({
				collectionSettings: defaultSettings({ commentsModeration: "all" }),
				priorApprovedCount: 10,
			}),
			ctx,
		);

		expect(decision.status).toBe("pending");
	});
});

// ---------------------------------------------------------------------------
// Group 3: Real HookPipeline integration
// ---------------------------------------------------------------------------

describe("Comment Hooks with HookPipeline", () => {
	let pipelineDb: Kysely<Database>;

	beforeEach(async () => {
		pipelineDb = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(pipelineDb);
	});

	it("invokes comment:beforeCreate handler registered via definePlugin", async () => {
		const spy = vi.fn(async (event: CommentBeforeCreateEvent) => ({
			...event,
			metadata: { ...event.metadata, enriched: true },
		}));

		const plugin = definePlugin({
			id: "test-enricher",
			version: "1.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:beforeCreate": spy,
			},
		});

		const pipeline = createHookPipeline([plugin], { db: pipelineDb });

		const event: CommentBeforeCreateEvent = {
			comment: {
				collection: "post",
				contentId: "c1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Hello",
				ipHash: null,
				userAgent: null,
			},
			metadata: {},
		};

		const result = await pipeline.runCommentBeforeCreate(event);

		expect(spy).toHaveBeenCalledOnce();
		expect(result).not.toBe(false);
		expect((result as CommentBeforeCreateEvent).metadata.enriched).toBe(true);
	});

	it("invokes exclusive comment:moderate plugin and returns decision", async () => {
		const moderateHandler = vi.fn(async () => ({
			status: "spam" as const,
			reason: "Custom moderator",
		}));

		const plugin = definePlugin({
			id: "test-moderator",
			version: "1.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:moderate": {
					exclusive: true,
					handler: moderateHandler,
				},
			},
		});

		const pipeline = createHookPipeline([plugin], { db: pipelineDb });

		// Auto-select the sole provider
		await resolveExclusiveHooks({
			pipeline,
			isActive: () => true,
			getOption: async () => null,
			setOption: async () => {},
			deleteOption: async () => {},
		});

		const moderateEvent: CommentModerateEvent = {
			comment: {
				collection: "post",
				contentId: "c1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Buy cheap pills",
				ipHash: null,
				userAgent: null,
			},
			metadata: {},
			collectionSettings: defaultSettings(),
			priorApprovedCount: 0,
		};

		const result = await pipeline.invokeExclusiveHook("comment:moderate", moderateEvent);

		expect(result).not.toBeNull();
		expect((result!.result as ModerationDecision).status).toBe("spam");
		expect(moderateHandler).toHaveBeenCalledOnce();
	});

	it("built-in moderator is auto-selected when sole provider", async () => {
		const { DEFAULT_COMMENT_MODERATOR_PLUGIN_ID } =
			await import("../../../src/comments/moderator.js");

		const plugin = definePlugin({
			id: DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
			version: "0.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:moderate": {
					exclusive: true,
					handler: defaultCommentModerate,
				},
			},
		});

		const pipeline = createHookPipeline([plugin], { db: pipelineDb });

		await resolveExclusiveHooks({
			pipeline,
			isActive: () => true,
			getOption: async () => null,
			setOption: async () => {},
			deleteOption: async () => {},
		});

		const selection = pipeline.getExclusiveSelection("comment:moderate");
		expect(selection).toBe(DEFAULT_COMMENT_MODERATOR_PLUGIN_ID);

		// Verify it actually works
		const moderateEvent: CommentModerateEvent = {
			comment: {
				collection: "post",
				contentId: "c1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Hello",
				ipHash: null,
				userAgent: null,
			},
			metadata: {},
			collectionSettings: defaultSettings({ commentsModeration: "none" }),
			priorApprovedCount: 0,
		};

		const result = await pipeline.invokeExclusiveHook("comment:moderate", moderateEvent);
		expect(result).not.toBeNull();
		expect((result!.result as ModerationDecision).status).toBe("approved");
	});

	it("fires comment:afterCreate handlers", async () => {
		const spy = vi.fn(async () => {});

		const plugin = definePlugin({
			id: "test-after-create",
			version: "1.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:afterCreate": spy,
			},
		});

		const pipeline = createHookPipeline([plugin], { db: pipelineDb });

		await pipeline.runCommentAfterCreate({
			comment: {
				id: "c1",
				collection: "post",
				contentId: "content-1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Hello",
				status: "approved",
				moderationMetadata: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			metadata: {},
			content: { id: "content-1", collection: "post", slug: "my-post" },
		});

		expect(spy).toHaveBeenCalledOnce();
	});

	it("fires comment:afterModerate handlers", async () => {
		const spy = vi.fn(async () => {});

		const plugin = definePlugin({
			id: "test-after-moderate",
			version: "1.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:afterModerate": spy,
			},
		});

		const pipeline = createHookPipeline([plugin], { db: pipelineDb });

		await pipeline.runCommentAfterModerate({
			comment: {
				id: "c1",
				collection: "post",
				contentId: "content-1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: null,
				body: "Hello",
				status: "approved",
				moderationMetadata: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			previousStatus: "pending",
			newStatus: "approved",
			moderator: { id: "admin-1", name: "Admin" },
		});

		expect(spy).toHaveBeenCalledOnce();
	});
});
