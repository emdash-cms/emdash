import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleContentDelete,
	handleContentPermanentDelete,
} from "../../../src/api/handlers/content.js";
import { deleteSharedCollectionRecords } from "../../../src/database/collection-cleanup.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	EditorialThreadRepository,
	type EditorialAnchor,
} from "../../../src/database/repositories/editorial-threads.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ADA = "user-ada";
const LINUS = "user-linus";
const TEXT_ANCHOR: EditorialAnchor = {
	type: "text",
	field: "content",
	blockKey: "b1",
	start: 4,
	end: 9,
	quote: "quick",
	prefix: "The ",
	suffix: " brown fox",
};

let clock = 0;
function now(): string {
	clock += 1;
	return new Date(Date.UTC(2026, 10, 6, 12, 0, clock)).toISOString();
}

describeEachDialect("editorial threads", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let threads: EditorialThreadRepository;
	let entryId: string;
	let otherEntryId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		threads = new EditorialThreadRepository(db);
		await db
			.insertInto("users")
			.values([
				{
					id: ADA,
					email: "ada@example.com",
					name: "Ada",
					role: 40,
					email_verified: 1,
					avatar_url: null,
					data: null,
				},
				{
					id: LINUS,
					email: "linus@example.com",
					name: "Linus",
					role: 20,
					email_verified: 1,
					avatar_url: "https://example.com/l.png",
					data: null,
				},
			])
			.execute();
		const content = new ContentRepository(db);
		entryId = (await content.create({ type: "post", data: { title: "One" } })).id;
		otherEntryId = (await content.create({ type: "post", data: { title: "Two" } })).id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createThread(entry = entryId, anchor: EditorialAnchor = TEXT_ANCHOR) {
		return threads.createThread({
			collection: "post",
			entryId: entry,
			anchor,
			createdBy: ADA,
			body: "Source?",
			now: now(),
		});
	}

	it("lists an entry's threads with their comments in order", async () => {
		const { threadId } = await createThread();
		await threads.addComment({ threadId, authorId: LINUS, body: "Linked it.", now: now() });
		await createThread(otherEntryId);

		const page = await threads.listForEntry("post", entryId, { limit: 50 });

		expect(page.nextCursor).toBeUndefined();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({
			id: threadId,
			anchor: TEXT_ANCHOR,
			anchorState: "attached",
			status: "open",
			createdBy: ADA,
			comments: [
				{ body: "Source?", author: { id: ADA, name: "Ada", avatarUrl: null } },
				{
					body: "Linked it.",
					author: { id: LINUS, name: "Linus", avatarUrl: "https://example.com/l.png" },
				},
			],
		});
	});

	it("pages through threads without splitting their comments", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			// oxlint-disable-next-line no-await-in-loop -- creation order is the list order
			const { threadId } = await createThread();
			// oxlint-disable-next-line no-await-in-loop -- creation order is the list order
			await threads.addComment({ threadId, authorId: LINUS, body: `Reply ${i}`, now: now() });
			ids.push(threadId);
		}

		const first = await threads.listForEntry("post", entryId, { limit: 2 });
		expect(first.items.map((t) => t.id)).toEqual(ids.slice(0, 2));
		expect(first.items.every((t) => t.comments.length === 2)).toBe(true);
		expect(first.nextCursor).toBeDefined();

		const second = await threads.listForEntry("post", entryId, {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.items.map((t) => t.id)).toEqual(ids.slice(2));
		expect(second.items[0]!.comments).toHaveLength(2);
		expect(second.nextCursor).toBeUndefined();
	});

	it("filters by status and names who resolved a thread", async () => {
		const open = await createThread();
		const resolved = await createThread();
		await threads.setStatus({
			threadId: resolved.threadId,
			status: "resolved",
			userId: LINUS,
			now: now(),
		});

		const openPage = await threads.listForEntry("post", entryId, { status: "open", limit: 50 });
		const resolvedPage = await threads.listForEntry("post", entryId, {
			status: "resolved",
			limit: 50,
		});

		expect(openPage.items.map((t) => t.id)).toEqual([open.threadId]);
		expect(resolvedPage.items[0]).toMatchObject({
			id: resolved.threadId,
			status: "resolved",
			resolvedBy: { id: LINUS, name: "Linus" },
		});
		expect(resolvedPage.items[0]!.resolvedAt).not.toBeNull();
	});

	it("reopens a resolved thread when someone replies", async () => {
		const { threadId } = await createThread();
		await threads.setStatus({ threadId, status: "resolved", userId: ADA, now: now() });

		await threads.addComment({ threadId, authorId: LINUS, body: "Not yet", now: now() });

		expect(await threads.findThread(threadId)).toMatchObject({
			status: "open",
			resolvedBy: null,
			resolvedAt: null,
		});
	});

	it("keeps a deleted comment in place with an empty body", async () => {
		const { threadId, commentId } = await createThread();
		await threads.addComment({ threadId, authorId: LINUS, body: "Reply", now: now() });

		const threadDeleted = await threads.deleteComment({ commentId, threadId, now: now() });

		expect(threadDeleted).toBe(false);
		const [thread] = (await threads.listForEntry("post", entryId, { limit: 50 })).items;
		expect(thread!.comments[0]).toMatchObject({ id: commentId, body: "" });
		expect(thread!.comments[0]!.deletedAt).not.toBeNull();
		expect(thread!.comments[1]).toMatchObject({ body: "Reply", deletedAt: null });
	});

	it("deletes the thread when its last live comment is deleted", async () => {
		const { threadId, commentId } = await createThread();

		const threadDeleted = await threads.deleteComment({ commentId, threadId, now: now() });

		expect(threadDeleted).toBe(true);
		expect(await threads.findThread(threadId)).toBeNull();
		expect(await threads.findComment(commentId)).toBeNull();
	});

	it("shows comments from a deleted user without an author", async () => {
		const { threadId } = await createThread();
		await threads.addComment({ threadId, authorId: LINUS, body: "Bye", now: now() });
		await threads.setStatus({ threadId, status: "resolved", userId: LINUS, now: now() });

		await db.deleteFrom("users").where("id", "=", LINUS).execute();

		const [thread] = (await threads.listForEntry("post", entryId, { limit: 50 })).items;
		expect(thread!.resolvedBy).toBeNull();
		expect(thread!.comments[1]).toMatchObject({ body: "Bye", author: null });
	});

	it("updates anchors only for threads on the named entry", async () => {
		const mine = await createThread();
		const theirs = await createThread(otherEntryId);
		const moved: EditorialAnchor = { ...TEXT_ANCHOR, start: 16, end: 21 };

		await threads.updateAnchors({
			collection: "post",
			entryId,
			updates: [
				{ threadId: mine.threadId, anchor: moved, anchorState: "attached" },
				{ threadId: theirs.threadId, anchor: moved, anchorState: "orphaned" },
			],
			now: now(),
		});

		expect(await threads.findThread(mine.threadId)).toMatchObject({ anchor: moved });
		expect(await threads.findThread(theirs.threadId)).toMatchObject({
			anchor: TEXT_ANCHOR,
			anchorState: "attached",
		});
	});

	describe("entry lifecycle", () => {
		it("keeps threads when an entry moves to the trash", async () => {
			const { threadId } = await createThread();

			await handleContentDelete(db, "post", entryId);

			expect(await threads.findThread(threadId)).not.toBeNull();
		});

		it("deletes an entry's threads and comments when it is permanently deleted", async () => {
			const { threadId, commentId } = await createThread();
			const other = await createThread(otherEntryId);
			await handleContentDelete(db, "post", entryId);

			const result = await handleContentPermanentDelete(db, "post", entryId);

			expect(result.success).toBe(true);
			expect(await threads.findThread(threadId)).toBeNull();
			expect(await threads.findComment(commentId)).toBeNull();
			expect(await threads.findThread(other.threadId)).not.toBeNull();
		});

		it("deletes a collection's threads with the collection's shared records", async () => {
			const { threadId, commentId } = await createThread();
			const pageEntry = (
				await new ContentRepository(db).create({ type: "page", data: { title: "P" } })
			).id;
			const onPage = await threads.createThread({
				collection: "page",
				entryId: pageEntry,
				anchor: { type: "entry" },
				createdBy: ADA,
				body: "Hi",
				now: now(),
			});

			await deleteSharedCollectionRecords(db, "post");

			expect(await threads.findThread(threadId)).toBeNull();
			expect(await threads.findComment(commentId)).toBeNull();
			expect(await threads.findThread(onPage.threadId)).not.toBeNull();
		});
	});
});
