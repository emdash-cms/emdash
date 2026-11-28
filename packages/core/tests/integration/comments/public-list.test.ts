import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCommentList } from "../../../src/api/handlers/comments.js";
import { GET as listComments } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/index.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("public comment list", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		content = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost(id: string, status: "draft" | "published") {
		await content.create({
			id,
			type: "post",
			slug: id,
			data: { title: id },
			status,
			publishedAt: status === "published" ? new Date().toISOString() : undefined,
		});
		await new CommentRepository(ctx.db).create({
			collection: "post",
			contentId: id,
			authorName: "Dana",
			authorEmail: "dana@example.net",
			body: `comment on ${id}`,
			status: "approved",
		});
	}

	const notFound = { success: false, error: { code: "NOT_FOUND", message: "Content not found" } };

	describe("handleCommentList", () => {
		it("lists the approved comments of a published entry", async () => {
			await createPost("post-1", "published");

			for (const threaded of [false, true]) {
				const result = await handleCommentList(ctx.db, "post", "post-1", { threaded });
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.total).toBe(1);
				expect(result.data.items.map((c) => c.body)).toEqual(["comment on post-1"]);
			}
		});

		it("returns NOT_FOUND for a draft entry", async () => {
			await createPost("post-1", "draft");
			expect(await handleCommentList(ctx.db, "post", "post-1")).toEqual(notFound);
		});

		it("returns NOT_FOUND once an entry is unpublished", async () => {
			await createPost("post-1", "published");
			await content.unpublish("post", "post-1");

			for (const threaded of [false, true]) {
				expect(await handleCommentList(ctx.db, "post", "post-1", { threaded })).toEqual(notFound);
			}
		});

		it("returns NOT_FOUND once an entry is moved to the trash", async () => {
			await createPost("post-1", "published");
			await content.delete("post", "post-1");
			expect(await handleCommentList(ctx.db, "post", "post-1")).toEqual(notFound);
		});

		it("returns NOT_FOUND for an entry that does not exist", async () => {
			expect(await handleCommentList(ctx.db, "post", "does-not-exist")).toEqual(notFound);
		});
	});

	describe("GET /_emdash/api/comments/{collection}/{contentId}", () => {
		function listAnonymously(contentId: string) {
			return listComments({
				params: { collection: "post", contentId },
				url: new URL(`http://localhost/_emdash/api/comments/post/${contentId}`),
				locals: { emdash: { db: ctx.db } },
			} as unknown as Parameters<typeof listComments>[0]);
		}

		beforeEach(async () => {
			await new SchemaRegistry(ctx.db).updateCollection("post", { commentsEnabled: true });
			await createPost("post-1", "published");
		});

		it("returns 200 with the comments of a published entry", async () => {
			const response = await listAnonymously("post-1");
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("comment on post-1");
		});

		it("returns 404 without the comments of an unpublished entry", async () => {
			await content.unpublish("post", "post-1");

			const response = await listAnonymously("post-1");
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("comment on post-1");
		});

		it("returns 404 without the comments of a trashed entry", async () => {
			await content.delete("post", "post-1");

			const response = await listAnonymously("post-1");
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("comment on post-1");
		});
	});
});
