import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("../../src/loader.js", () => ({ getDb: vi.fn() }));

import { getComments } from "../../src/comments/query.js";
import { CommentReactionRepository } from "../../src/database/repositories/comment-reaction.js";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { getDb } from "../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { invalidateUrlPatternCache } from "../../src/query.js";
import { getCollectionInfo } from "../../src/schema/query.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (k) => Promise.resolve(store.get(k) ?? null),
		set: (k, v) => {
			store.set(k, v);
			return Promise.resolve();
		},
		delete: (k) => {
			store.delete(k);
			return Promise.resolve();
		},
	};
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("object cache: schema (getCollectionInfo)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
	});
	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("serves the second read from KV, and busts on a schema change", async () => {
		const first = await getCollectionInfo("post");
		expect(first?.slug).toBe("post");
		await flush();

		// D1 down — a cached read must not need it.
		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));
		const second = await getCollectionInfo("post");
		expect(second?.slug).toBe("post");

		// A schema change bumps the schema epoch → next read reloads (and now
		// D1 is down, so it surfaces).
		invalidateUrlPatternCache();
		await flush();
		await expect(getCollectionInfo("post")).rejects.toThrow(/D1 unavailable/);
	});
});

describe("object cache: comments (getComments)", () => {
	let db: Kysely<Database>;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });

		const post = await new ContentRepository(db).create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		postId = post.id;
		await new CommentRepository(db).create({
			collection: "post",
			contentId: postId,
			authorName: "A",
			authorEmail: "a@example.com",
			body: "first!",
			status: "approved",
		});
		await flush();
	});
	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("serves the second read from KV, and busts when a comment is written", async () => {
		const first = await getComments({ collection: "post", contentId: postId });
		expect(first.total).toBe(1);
		await flush();

		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));
		const second = await getComments({ collection: "post", contentId: postId });
		expect(second.total).toBe(1); // served from KV, no D1

		// Posting another comment bumps the comments epoch → reload (D1 down).
		vi.mocked(getDb).mockResolvedValue(db);
		await new CommentRepository(db).create({
			collection: "post",
			contentId: postId,
			authorName: "B",
			authorEmail: "b@example.com",
			body: "second!",
			status: "approved",
		});
		await flush();
		const third = await getComments({ collection: "post", contentId: postId });
		expect(third.total).toBe(2);
	});

	it("does not collide when reactions/sort differ from a prior cached call", async () => {
		const base = await getComments({ collection: "post", contentId: postId });
		const commentId = base.items[0]!.id;
		await new CommentReactionRepository(db).toggle({
			commentId,
			reaction: "like",
			voterHash: "voter-1",
		});
		await flush();

		// Reaction-less call: no counts attached.
		const plain = await getComments({ collection: "post", contentId: postId });
		expect(plain.items[0]!.reactions).toBeUndefined();
		await flush();

		// reactions:true must get its own entry, not the reaction-less snapshot.
		const withReactions = await getComments({
			collection: "post",
			contentId: postId,
			reactions: true,
		});
		expect(withReactions.items[0]!.reactions).toEqual({ like: 1 });
	});
});
