import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DELETE as deleteComment } from "../../../src/astro/routes/api/admin/comments/[id].js";
import { PUT as updateCommentStatus } from "../../../src/astro/routes/api/admin/comments/[id]/status.js";
import { POST as bulkComments } from "../../../src/astro/routes/api/admin/comments/bulk.js";
import { POST as submitComment } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/index.js";
import {
	DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
	defaultCommentModerate,
} from "../../../src/comments/moderator.js";
import { moderateComment } from "../../../src/comments/service.js";
import { CommentRepository, type Comment } from "../../../src/database/repositories/comment.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { HookPipeline } from "../../../src/plugins/hooks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	type DialectTestContext,
	asInlineTransaction,
	teardownForDialect,
} from "../../utils/test-db.js";

const admin = { id: "admin-1", name: "Admin", role: Role.ADMIN };

/** A route-cache stand-in that evicts snapshots by the tags supplied by a write. */
class FakeRouteCache {
	readonly pages = new Map<string, string[]>();
	readonly invalidations: string[][] = [];
	failInvalidation = false;

	constructor(readonly enabled = true) {}

	set(key: string, tags: string[]): void {
		this.pages.set(key, tags);
	}

	async invalidate(input: { tags: string[] }): Promise<void> {
		this.invalidations.push(input.tags);
		if (input.tags.length > 100) throw new Error("too many cache tags");
		if (this.failInvalidation) throw new Error("cache unavailable");
		for (const [key, page] of this.pages) {
			if (page.some((tag) => input.tags.includes(tag))) this.pages.delete(key);
		}
	}
}

describeEachDialect("comment route cache invalidation", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let comments: CommentRepository;
	let hooks: HookPipeline;
	let cache: FakeRouteCache;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		comments = new CommentRepository(db);
		const defaultModerator = definePlugin({
			id: DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
			version: "0.0.0",
			capabilities: ["users:read"],
			hooks: {
				"comment:moderate": { exclusive: true, handler: defaultCommentModerate },
			},
		});
		hooks = createHookPipeline([defaultModerator], { db });
		hooks.setExclusiveSelection("comment:moderate", DEFAULT_COMMENT_MODERATOR_PLUGIN_ID);
		cache = new FakeRouteCache();
		await new SchemaRegistry(db).updateCollection("post", {
			commentsEnabled: true,
			commentsModeration: "all",
		});
		await new SchemaRegistry(db).updateCollection("page", {
			commentsEnabled: true,
			commentsModeration: "all",
		});
		const content = new ContentRepository(db);
		await content.create({
			id: "post-1",
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
		await content.create({
			id: "post-2",
			type: "post",
			slug: "another",
			data: { title: "Another" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
		await content.create({
			id: "page-1",
			type: "page",
			slug: "page",
			data: { title: "Page" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function runtime(runtimeDb = db) {
		return {
			db: runtimeDb,
			config: {},
			email: null,
			hooks,
			handleCommentModerate: (
				id: string,
				status: "pending" | "approved" | "spam" | "trash",
				moderator: { id: string; name: string | null },
				expectedStatus?: "pending" | "approved" | "spam" | "trash",
			) =>
				moderateComment(
					runtimeDb,
					id,
					status,
					expectedStatus ?? "pending",
					{ source: "admin", userId: moderator.id, name: moderator.name },
					{
						runBeforeCreate: async (event) => event,
						runModerate: async () => ({ status: "pending" as const }),
						fireAfterCreate: () => undefined,
						fireAfterModerate: (event) => hooks.runCommentAfterModerate(event),
					},
				),
		};
	}

	function context(route: {
		params?: Record<string, string>;
		request?: Request;
		locals?: Record<string, unknown>;
	}): APIContext {
		return {
			params: route.params ?? { collection: "post", contentId: "post-1" },
			request: route.request,
			cache,
			locals: {
				emdash: runtime(),
				user: admin,
				...route.locals,
			},
		} as unknown as APIContext;
	}

	function pageTags(collection = "post", contentId = "post-1"): string[] {
		return [collection, contentId];
	}

	async function createComment(
		status: Comment["status"] = "pending",
		contentId = "post-1",
		parentId?: string,
	) {
		return comments.create({
			collection: "post",
			contentId,
			authorName: "Jane",
			authorEmail: `${contentId}@example.com`,
			body: "A comment",
			status,
			parentId,
		});
	}

	it("purges only approved public submissions, while pending and honeypot submissions retain pages", async () => {
		cache.set("post", ["post-1"]);
		cache.set("unrelated", ["page", "page-1"]);
		const pendingResponse = await submitComment(
			context({
				locals: { user: undefined },
				request: new Request("http://localhost/_emdash/api/comments/post/post-1", {
					method: "POST",
					body: JSON.stringify({
						authorName: "Jane",
						authorEmail: "jane@example.com",
						body: "Pending",
					}),
				}),
			}),
		);
		expect(pendingResponse.status).toBe(201);
		expect(cache.pages.has("post")).toBe(true);

		await new SchemaRegistry(db).updateCollection("post", { commentsModeration: "none" });
		const approvedResponse = await submitComment(
			context({
				locals: { user: undefined },
				request: new Request("http://localhost/_emdash/api/comments/post/post-1", {
					method: "POST",
					body: JSON.stringify({
						authorName: "Jane",
						authorEmail: "new@example.com",
						body: "Approved",
					}),
				}),
			}),
		);
		expect(approvedResponse.status).toBe(201);
		expect(cache.pages.has("post")).toBe(false);
		expect(cache.pages.has("unrelated")).toBe(true);

		cache.set("post", ["post-1"]);
		const honeypotResponse = await submitComment(
			context({
				locals: { user: undefined },
				request: new Request("http://localhost/_emdash/api/comments/post/post-1", {
					method: "POST",
					body: JSON.stringify({
						authorName: "Bot",
						authorEmail: "bot@example.com",
						body: "Spam",
						website_url: "https://spam.example",
					}),
				}),
			}),
		);
		expect(honeypotResponse.status).toBe(200);
		expect(cache.pages.has("post")).toBe(true);
	});

	it("purges public first-time returning and CMS-user auto-approved submissions", async () => {
		await comments.create({
			collection: "post",
			contentId: "post-1",
			authorName: "Jane",
			authorEmail: "returning@example.com",
			body: "Already approved",
			status: "approved",
		});
		await new SchemaRegistry(db).updateCollection("post", { commentsModeration: "first_time" });
		cache.set("returning", pageTags());
		const returning = await submitComment(
			context({
				locals: { user: undefined },
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({
						authorName: "Jane",
						authorEmail: "returning@example.com",
						body: "Welcome back",
					}),
				}),
			}),
		);
		expect(returning.status).toBe(201);
		expect(cache.pages.has("returning")).toBe(false);

		await db
			.insertInto("users")
			.values({
				id: "commenter-1",
				email: "member@example.com",
				name: "Member",
				role: Role.ADMIN,
				email_verified: 1,
			})
			.execute();
		await new SchemaRegistry(db).updateCollection("post", {
			commentsModeration: "all",
			commentsAutoApproveUsers: true,
		});
		cache.set("member", pageTags());
		const member = await submitComment(
			context({
				locals: {
					user: {
						id: "commenter-1",
						name: "Member",
						email: "member@example.com",
						role: Role.ADMIN,
					},
				},
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({
						authorName: "Member",
						authorEmail: "member@example.com",
						body: "Hi",
					}),
				}),
			}),
		);
		expect(member.status).toBe(201);
		expect(cache.pages.has("member")).toBe(false);
	});

	it("does not purge for a pending-to-spam transition", async () => {
		const comment = await createComment("pending");
		cache.set("post", ["post-1"]);
		const response = await updateCommentStatus(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "spam" }),
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(cache.pages.has("post")).toBe(true);
		expect((await comments.findById(comment.id))?.status).toBe("spam");
	});

	it("purges status transitions involving approved, but not missing or unauthorized writes", async () => {
		const comment = await createComment("pending");
		cache.set("post", ["post-1"]);
		const approved = await updateCommentStatus(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "approved" }),
				}),
			}),
		);
		expect(approved.status).toBe(200);
		expect(cache.pages.has("post")).toBe(false);

		cache.set("post", ["post-1"]);
		const spam = await updateCommentStatus(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "spam" }),
				}),
			}),
		);
		expect(spam.status).toBe(200);
		expect(cache.pages.has("post")).toBe(false);

		cache.set("post", ["post-1"]);
		const missing = await updateCommentStatus(
			context({
				params: { id: "missing-comment" },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "approved" }),
				}),
			}),
		);
		expect(missing.status).toBe(404);
		expect(cache.pages.has("post")).toBe(true);

		cache.set("post", ["post-1"]);
		const denied = await updateCommentStatus(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "pending" }),
				}),
				locals: { user: { id: "viewer", name: "Viewer", role: Role.SUBSCRIBER } },
			}),
		);
		expect(denied.status).toBe(403);
		expect(cache.pages.has("post")).toBe(true);
	});

	it.each(["pending", "spam", "trash", "approved"] as const)(
		"deleting a %s comment only purges when its own entry was visible",
		async (status) => {
			const comment = await createComment(status);
			const reply = await createComment("pending", "post-1", comment.id);
			cache.set("entry", ["post-1"]);
			const response = await deleteComment(
				context({
					params: { id: comment.id },
					request: new Request("http://localhost", { method: "DELETE" }),
				}),
			);
			expect(response.status).toBe(200);
			expect(cache.pages.has("entry")).toBe(status !== "approved");
			expect(cache.invalidations).toEqual(status === "approved" ? [["post", "post-1"]] : []);
			expect(await comments.findById(comment.id)).toBeNull();
			expect(await comments.findById(reply.id)).toBeNull();
		},
	);

	it("deleting a missing comment returns 404 without spending a purge", async () => {
		cache.set("entry", ["post-1"]);
		const response = await deleteComment(
			context({
				params: { id: "missing-comment" },
				request: new Request("http://localhost", { method: "DELETE" }),
			}),
		);
		expect(response.status).toBe(404);
		expect(cache.pages.has("entry")).toBe(true);
		expect(cache.invalidations).toEqual([]);
	});

	it("deleting a pending comment purges its entry when it has an approved reply", async () => {
		const comment = await createComment("pending");
		const reply = await createComment("approved", "post-1", comment.id);
		cache.set("entry", ["post-1"]);
		const response = await deleteComment(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", { method: "DELETE" }),
			}),
		);
		expect(response.status).toBe(200);
		expect(cache.pages.has("entry")).toBe(false);
		expect(cache.invalidations).toEqual([["post", "post-1"]]);
		expect(await comments.findById(reply.id)).toBeNull();
	});

	it.each([
		["spam", false],
		["trash", false],
		["delete", false],
		["approve", true],
	] as const)(
		"bulk %s purges pending entries only when visibility changes",
		async (action, purges) => {
			const comment = await createComment("pending");
			cache.set("entry", ["post-1"]);
			const response = await bulkComments(
				context({
					request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
						method: "POST",
						body: JSON.stringify({ ids: [comment.id], action }),
					}),
				}),
			);
			expect(response.status).toBe(200);
			expect(cache.pages.has("entry")).toBe(!purges);
			expect(cache.invalidations).toEqual(purges ? [["post", "post-1"]] : []);
			expect((await comments.findById(comment.id))?.status ?? null).toBe(
				action === "delete" ? null : action === "approve" ? "approved" : action,
			);
		},
	);

	it.each([
		["approve", false],
		["spam", true],
		["trash", true],
		["delete", true],
	] as const)(
		"bulk %s handles already-approved entries without wasted purges",
		async (action, purges) => {
			const comment = await createComment("approved");
			cache.set("entry", ["post-1"]);
			const response = await bulkComments(
				context({
					request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
						method: "POST",
						body: JSON.stringify({ ids: [comment.id], action }),
					}),
				}),
			);
			expect(response.status).toBe(200);
			expect(cache.pages.has("entry")).toBe(!purges);
			expect(cache.invalidations).toEqual(purges ? [["post", "post-1"]] : []);
			expect((await comments.findById(comment.id))?.status ?? null).toBe(
				action === "delete" ? null : action === "approve" ? "approved" : action,
			);
		},
	);

	it("bulk status changes purge only entries whose visibility changes", async () => {
		const pending = await createComment("pending");
		const approved = await createComment("approved", "post-2");
		cache.set("pending", ["post-1"]);
		cache.set("approved", ["post-2"]);
		const response = await bulkComments(
			context({
				request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
					method: "POST",
					body: JSON.stringify({ ids: [pending.id, approved.id], action: "spam" }),
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(cache.pages.has("pending")).toBe(true);
		expect(cache.pages.has("approved")).toBe(false);
		expect(cache.invalidations).toEqual([["post", "post-2"]]);
	});

	it("bulk delete purges a pending parent with an approved reply", async () => {
		const parent = await createComment("pending");
		const reply = await createComment("approved", "post-1", parent.id);
		cache.set("entry", ["post-1"]);
		const response = await bulkComments(
			context({
				request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
					method: "POST",
					body: JSON.stringify({ ids: [parent.id], action: "delete" }),
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(cache.pages.has("entry")).toBe(false);
		expect(cache.invalidations).toEqual([["post", "post-1"]]);
		expect(await comments.findById(parent.id)).toBeNull();
		expect(await comments.findById(reply.id)).toBeNull();
	});

	it("bulk delete skips hidden entries while deduplicating affected entries across collections", async () => {
		const hidden = await createComment("pending", "post-1");
		const visible = await createComment("approved", "post-2");
		const other = await comments.create({
			collection: "page",
			contentId: "page-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Approved page comment",
			status: "approved",
		});
		cache.set("hidden", ["post-1"]);
		cache.set("visible", ["post-2"]);
		cache.set("other", ["page-1"]);
		const response = await bulkComments(
			context({
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({
						ids: [hidden.id, visible.id, visible.id, other.id, "missing"],
						action: "delete",
					}),
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(cache.pages.has("hidden")).toBe(true);
		expect(cache.pages.has("visible")).toBe(false);
		expect(cache.pages.has("other")).toBe(false);
		expect(cache.invalidations).toHaveLength(1);
		expect(cache.invalidations[0]?.toSorted()).toEqual(
			["post", "post-2", "page", "page-1"].toSorted(),
		);
		for (const comment of [hidden, visible, other])
			expect(await comments.findById(comment.id)).toBeNull();
	});

	it("invalidates the maximum-size bulk request without exceeding the cache tag limit", async () => {
		const content = new ContentRepository(db);
		const selected: Comment[] = [];
		for (let index = 0; index < 100; index++) {
			const contentId = `bulk-post-${index}`;
			await content.create({
				id: contentId,
				type: "post",
				slug: contentId,
				data: { title: contentId },
				status: "published",
				publishedAt: new Date().toISOString(),
			});
			selected.push(await createComment("pending", contentId));
			cache.set(`entry-${contentId}`, [contentId]);
		}
		cache.set("unrelated", ["other", "other-1"]);

		const response = await bulkComments(
			context({
				request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
					method: "POST",
					body: JSON.stringify({ ids: selected.map((comment) => comment.id), action: "approve" }),
				}),
			}),
		);

		expect(response.status).toBe(200);
		for (const comment of selected) {
			expect(cache.pages.has(`entry-${comment.contentId}`)).toBe(false);
			expect((await comments.findById(comment.id))?.status).toBe("approved");
		}
		expect(cache.pages.has("unrelated")).toBe(true);
	});

	it("bulk delete batches reply lookups for 100 pending parents", async () => {
		const content = new ContentRepository(db);
		const parents: Comment[] = [];
		for (let index = 0; index < 100; index++) {
			const contentId = `delete-post-${index}`;
			await content.create({
				id: contentId,
				type: "post",
				slug: contentId,
				data: { title: contentId },
				status: "published",
				publishedAt: new Date().toISOString(),
			});
			const parent = await createComment("pending", contentId);
			await createComment("approved", contentId, parent.id);
			parents.push(parent);
			cache.set(`entry-${contentId}`, [contentId]);
		}

		const response = await bulkComments(
			context({
				request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
					method: "POST",
					body: JSON.stringify({ ids: parents.map((parent) => parent.id), action: "delete" }),
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(cache.invalidations.length).toBeGreaterThan(0);
		expect(cache.invalidations.every((tags) => tags.length <= 100)).toBe(true);
		const invalidatedTags = cache.invalidations.flat();
		for (const parent of parents) {
			expect(invalidatedTags).toContain(parent.contentId);
			expect(cache.pages.has(`entry-${parent.contentId}`)).toBe(false);
			expect(await comments.findById(parent.id)).toBeNull();
		}
	});

	it.skipIf(dialect !== "sqlite")(
		"invalidates every entry when a later bulk status batch fails on D1",
		async () => {
			const selected: Comment[] = [];
			const content = new ContentRepository(db);
			for (let index = 0; index < 51; index++) {
				const contentId = `partial-post-${index}`;
				await content.create({
					id: contentId,
					type: "post",
					slug: contentId,
					data: { title: contentId },
					status: "published",
					publishedAt: new Date().toISOString(),
				});
				selected.push(await createComment("pending", contentId));
				cache.set(`entry-${index}`, [contentId]);
			}
			cache.set("unrelated", ["other", "other-1"]);
			const failed = selected[50]!;
			await db
				.updateTable("_emdash_comments")
				.set({ body: "Reject update" })
				.where("id", "=", failed.id)
				.execute();
			await sql`
				CREATE TRIGGER reject_comment_status_for_bulk_test
				BEFORE UPDATE OF status ON _emdash_comments
				WHEN OLD.body = 'Reject update'
				BEGIN
					SELECT RAISE(ABORT, 'bulk test rejection');
				END
			`.execute(db);

			const inlineDb = asInlineTransaction(db);
			const response = await bulkComments(
				context({
					locals: { emdash: runtime(inlineDb) },
					request: new Request("http://localhost/_emdash/api/admin/comments/bulk", {
						method: "POST",
						body: JSON.stringify({
							ids: selected.map((comment) => comment.id),
							action: "approve",
						}),
					}),
				}),
			);

			expect(response.status).toBe(500);
			for (const [index, comment] of selected.entries()) {
				expect((await comments.findById(comment.id))?.status).toBe(
					index < 50 ? "approved" : "pending",
				);
				expect(cache.pages.has(`entry-${index}`)).toBe(false);
			}
			expect(cache.pages.has("unrelated")).toBe(true);
		},
	);

	it("leaves cache intact for unauthorized and invalid bulk writes", async () => {
		const comment = await createComment("pending");
		cache.set("post", ["post-1"]);
		const denied = await bulkComments(
			context({
				locals: { user: { id: "viewer", name: "Viewer", role: Role.SUBSCRIBER } },
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({ ids: [comment.id], action: "approve" }),
				}),
			}),
		);
		expect(denied.status).toBe(403);
		expect(cache.pages.has("post")).toBe(true);

		const invalid = await bulkComments(
			context({
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({ ids: [], action: "approve" }),
				}),
			}),
		);
		expect(invalid.status).toBe(400);
		expect(cache.pages.has("post")).toBe(true);
	});

	it("keeps a successful write successful when cache is disabled, unavailable, or absent", async () => {
		const comment = await createComment("pending");
		cache.set("post", ["post-1"]);
		const disabledCache = new FakeRouteCache(false);
		disabledCache.set("post", ["post-1"]);
		const disabledContext = context({
			params: { id: comment.id },
			request: new Request("http://localhost", {
				method: "PUT",
				body: JSON.stringify({ status: "approved" }),
			}),
		});
		(disabledContext as unknown as { cache: unknown }).cache = disabledCache;
		const disabledResponse = await updateCommentStatus(disabledContext);
		expect(disabledResponse.status).toBe(200);
		expect(disabledCache.pages.has("post")).toBe(true);

		cache.failInvalidation = true;
		const response = await updateCommentStatus(
			context({
				params: { id: comment.id },
				request: new Request("http://localhost", {
					method: "PUT",
					body: JSON.stringify({ status: "spam" }),
				}),
			}),
		);
		expect(response.status).toBe(200);

		await comments.updateStatus(comment.id, "approved");
		const noCacheContext = context({
			params: { id: comment.id },
			request: new Request("http://localhost", {
				method: "PUT",
				body: JSON.stringify({ status: "pending" }),
			}),
		});
		(noCacheContext as unknown as { cache?: unknown }).cache = undefined;
		const noCacheResponse = await updateCommentStatus(noCacheContext);
		expect(noCacheResponse.status).toBe(200);
	});
});
