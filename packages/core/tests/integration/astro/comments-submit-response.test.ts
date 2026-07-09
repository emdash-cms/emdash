/**
 * POST /_emdash/api/comments/:collection/:contentId — response payload.
 *
 * Covers the additive `comment` field added for opt-in live/optimistic
 * display (<Comments live> / <CommentForm live>): the top-level
 * `{ id, status, message }` shape is unchanged, and a serialized comment
 * payload is now included so the client can render the new comment without
 * a page reload — in the correct muted state when it's awaiting moderation.
 *
 * Uses the same direct-route-invocation pattern as
 * comments-rate-limit.test.ts / comments-turnstile.test.ts (no dev server).
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postComment } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/index.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/comments/post/post-1", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function buildContext(opts: {
	db: Kysely<Database>;
	request: Request;
	/** Simulates a plugin-configured comment:moderate hook. `null` = none configured (pending). */
	moderateResult?: { status: "approved" | "pending" | "spam" } | null;
	user?: { id: string; name: string | null; email: string } | null;
}): APIContext {
	return {
		params: { collection: "post", contentId: "post-1" },
		request: opts.request,
		locals: {
			emdash: {
				db: opts.db,
				config: {},
				hooks: {
					runCommentBeforeCreate: async (event: unknown) => event,
					invokeExclusiveHook: async () =>
						opts.moderateResult === undefined
							? null
							: { result: opts.moderateResult },
					runCommentAfterCreate: async () => undefined,
					runCommentAfterModerate: async () => undefined,
				},
			},
			user: opts.user ?? null,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("POST /comments — response payload", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			commentsEnabled: true,
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await db
			.insertInto("ec_post" as never)
			.values({
				id: "post-1",
				slug: "post-1",
				status: "published",
				published_at: new Date().toISOString(),
				title: "Test post",
			} as never)
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("includes a serialized comment payload alongside the existing id/status/message fields", async () => {
		const res = await postComment(
			buildContext({
				db,
				request: buildRequest({
					authorName: "Jane",
					authorEmail: "jane@example.com",
					body: "Hello world",
				}),
				moderateResult: { status: "approved" },
			}),
		);
		expect(res.status).toBe(201);

		const json = (await res.json()) as {
			data: {
				id: string;
				status: string;
				message: string;
				comment: {
					id: string;
					parentId: string | null;
					authorName: string;
					isRegisteredUser: boolean;
					body: string;
					createdAt: string;
					status: string;
				};
			};
		};

		// Existing fields untouched.
		expect(json.data.id).toBeDefined();
		expect(json.data.status).toBe("approved");
		expect(json.data.message).toBe("Comment published");

		// New: additive `comment` payload — same shape the SSR list needs.
		expect(json.data.comment.id).toBe(json.data.id);
		expect(json.data.comment.parentId).toBeNull();
		expect(json.data.comment.authorName).toBe("Jane");
		expect(json.data.comment.isRegisteredUser).toBe(false);
		expect(json.data.comment.body).toBe("Hello world");
		expect(json.data.comment.createdAt).toBeDefined();
		expect(json.data.comment.status).toBe("approved");
	});

	it("reports status 'pending' on the comment payload when no moderator approves it", async () => {
		const res = await postComment(
			buildContext({
				db,
				request: buildRequest({
					authorName: "Jane",
					authorEmail: "jane@example.com",
					body: "Needs review",
				}),
				// moderateResult omitted -> invokeExclusiveHook resolves null,
				// same as "no plugin configured" in production.
			}),
		);
		expect(res.status).toBe(201);

		const json = (await res.json()) as {
			data: { status: string; comment: { status: string } };
		};

		// This is the exact signal <Comments live> branches on to render the
		// "awaiting moderation — visible only to you" muted state instead of
		// a normal (looks-publicly-visible) comment row.
		expect(json.data.status).toBe("pending");
		expect(json.data.comment.status).toBe("pending");
	});

	it("marks isRegisteredUser true and carries parentId for an authenticated reply", async () => {
		// authorUserId FKs to users.id — insert the row a real authenticated
		// session would already have.
		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "reg@example.com",
				name: "Registered User",
				avatar_url: null,
				role: 10,
				email_verified: 1,
				data: null,
			})
			.execute();

		const rootRes = await postComment(
			buildContext({
				db,
				request: buildRequest({
					authorName: "Root Author",
					authorEmail: "root@example.com",
					body: "Root comment",
				}),
				moderateResult: { status: "approved" },
			}),
		);
		const rootJson = (await rootRes.json()) as { data: { id: string } };

		const replyRes = await postComment(
			buildContext({
				db,
				request: buildRequest({
					authorName: "ignored — user overrides",
					authorEmail: "ignored@example.com",
					body: "A reply",
					parentId: rootJson.data.id,
				}),
				moderateResult: { status: "approved" },
				user: { id: "user-1", name: "Registered User", email: "reg@example.com" },
			}),
		);
		expect(replyRes.status).toBe(201);

		const replyJson = (await replyRes.json()) as {
			data: {
				comment: {
					parentId: string | null;
					authorName: string;
					isRegisteredUser: boolean;
				};
			};
		};

		expect(replyJson.data.comment.parentId).toBe(rootJson.data.id);
		expect(replyJson.data.comment.authorName).toBe("Registered User");
		expect(replyJson.data.comment.isRegisteredUser).toBe(true);
	});
});
