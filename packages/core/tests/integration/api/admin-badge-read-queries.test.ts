import type { KyselyPlugin } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleCommentCounts } from "../../../src/api/handlers/comments.js";
import {
	handleContentAuthors,
	handleContentCreate,
	handleContentDelete,
} from "../../../src/api/handlers/content.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function queryCounter(): KyselyPlugin & { count: number } {
	return {
		count: 0,
		transformQuery(args) {
			return args.node;
		},
		async transformResult(args) {
			this.count++;
			return args.result;
		},
	};
}

describeEachDialect("admin badge reads", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists a collection's live authors in one query", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const users = new UserRepository(ctx.db);
		const bob = await users.create({ email: "bob@example.com", name: "Bob" });
		const alice = await users.create({ email: "alice@example.com", name: "Alice" });
		const trashedOnly = await users.create({ email: "dave@example.com", name: "Dave" });
		await users.create({ email: "carol@example.com", name: "Carol" });

		for (const [slug, authorId] of [
			["a1", alice.id],
			["a2", alice.id],
			["b1", bob.id],
		] as const) {
			const created = await handleContentCreate(ctx.db, "posts", {
				slug,
				data: { title: slug },
				authorId,
			});
			if (!created.success) throw new Error(created.error.message);
		}
		const trashed = await handleContentCreate(ctx.db, "posts", {
			slug: "d1",
			data: { title: "d1" },
			authorId: trashedOnly.id,
		});
		if (!trashed.success) throw new Error(trashed.error.message);
		const deleted = await handleContentDelete(ctx.db, "posts", trashed.data.item.id);
		if (!deleted.success) throw new Error(deleted.error.message);

		const counter = queryCounter();
		const result = await handleContentAuthors(ctx.db.withPlugin(counter), "posts");

		if (!result.success) throw new Error(result.error.message);
		expect(result.data.items).toEqual([
			{ id: alice.id, name: "Alice", email: "alice@example.com", avatarUrl: null },
			{ id: bob.id, name: "Bob", email: "bob@example.com", avatarUrl: null },
		]);
		expect(counter.count).toBe(1);
	});

	it("counts comments by status in one query", async () => {
		const comments = new CommentRepository(ctx.db);
		const statuses = [
			"pending",
			"approved",
			"approved",
			"spam",
			"trash",
			"trash",
			"trash",
		] as const;
		for (const status of statuses) {
			await comments.create({
				collection: "posts",
				contentId: "content-1",
				authorName: "Jane",
				authorEmail: "jane@example.com",
				body: "Hello",
				status,
			});
		}

		const counter = queryCounter();
		const result = await handleCommentCounts(ctx.db.withPlugin(counter));

		if (!result.success) throw new Error(result.error.message);
		expect(result.data).toEqual({ pending: 1, approved: 2, spam: 1, trash: 3 });
		expect(counter.count).toBe(1);
	});
});
