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
import { withTransaction } from "../../../src/database/transaction.js";
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

	it("pages one at a time through threads written at the same moment, in creation order", async () => {
		const at = now();
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			// oxlint-disable-next-line no-await-in-loop -- creation order is the list order
			const { threadId } = await threads.createThread({
				collection: "post",
				entryId,
				anchor: TEXT_ANCHOR,
				createdBy: ADA,
				body: `Thread ${i}`,
				now: at,
			});
			ids.push(threadId);
		}

		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			// oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
			const page = await threads.listForEntry("post", entryId, { limit: 1, cursor });
			seen.push(...page.items.map((t) => t.id));
			cursor = page.nextCursor;
		} while (cursor && seen.length <= ids.length);

		expect(seen).toEqual(ids);
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

	it("keeps the first deletion time when a comment is deleted again", async () => {
		const { threadId, commentId } = await createThread();
		await threads.addComment({ threadId, authorId: LINUS, body: "Reply", now: now() });
		const firstDeletion = now();
		await threads.deleteComment({ commentId, threadId, now: firstDeletion });

		const threadDeleted = await threads.deleteComment({ commentId, threadId, now: now() });

		expect(threadDeleted).toBe(false);
		expect((await threads.findComment(commentId))?.deletedAt).toBe(firstDeletion);
	});

	it("changes a comment only through its own thread", async () => {
		const { threadId, commentId } = await createThread();
		const other = await createThread(otherEntryId);
		const before = await threads.findThread(other.threadId);

		await threads.editComment({
			commentId,
			threadId: other.threadId,
			body: "Hijacked",
			now: now(),
		});
		const threadDeleted = await threads.deleteComment({
			commentId,
			threadId: other.threadId,
			now: now(),
		});

		expect(threadDeleted).toBe(false);
		expect((await threads.findComment(commentId))?.deletedAt).toBeNull();
		const [thread] = (await threads.listForEntry("post", entryId, { limit: 50 })).items;
		expect(thread?.id).toBe(threadId);
		expect(thread?.comments[0]?.body).toBe("Source?");
		expect((await threads.findThread(other.threadId))?.updatedAt).toBe(before?.updatedAt);
	});

	it("leaves no thread behind when its first comment can't be stored", async () => {
		await expect(
			withTransaction(db, (trx) =>
				new EditorialThreadRepository(trx).createThread({
					collection: "post",
					entryId,
					anchor: TEXT_ANCHOR,
					createdBy: ADA,
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a null body breaks the comment insert
					body: null as unknown as string,
					now: now(),
				}),
			),
		).rejects.toThrow();

		expect((await threads.listForEntry("post", entryId, { limit: 50 })).items).toEqual([]);
	});

	it("reports a reply or an edit to a thread that has been deleted", async () => {
		const { threadId, commentId } = await createThread();
		await threads.deleteThread(threadId);

		expect(
			await threads.addComment({ threadId, authorId: LINUS, body: "Here.", now: now() }),
		).toBeNull();
		expect(await threads.editComment({ commentId, threadId, body: "Later", now: now() })).toBe(
			false,
		);
		expect(await threads.findComment(commentId)).toBeNull();
	});

	it("reports an edit to a comment that has been deleted", async () => {
		const { threadId, commentId } = await createThread();
		await threads.addComment({ threadId, authorId: LINUS, body: "Here.", now: now() });
		await threads.deleteComment({ commentId, threadId, now: now() });

		expect(await threads.editComment({ commentId, threadId, body: "Later", now: now() })).toBe(
			false,
		);
	});

	it.runIf(dialect === "postgres")(
		"deletes a thread while its comments are being edited without deadlocking",
		async () => {
			const { threadId, commentId: first } = await createThread();
			const second = await threads.addComment({
				threadId,
				authorId: ADA,
				body: "Also this.",
				now: now(),
			});
			if (!second) throw new Error("Expected a reply");

			let releaseEdit!: () => void;
			const editHeld = new Promise<void>((resolve) => {
				releaseEdit = resolve;
			});
			let markEdited!: () => void;
			const edited = new Promise<void>((resolve) => {
				markEdited = resolve;
			});
			const edits = db.transaction().execute(async (trx) => {
				const repo = new EditorialThreadRepository(trx);
				await repo.editComment({ commentId: second, threadId, body: "Changed", now: now() });
				markEdited();
				await editHeld;
				await repo.editComment({ commentId: first, threadId, body: "Changed", now: now() });
			});
			await edited;
			const deletion = db
				.transaction()
				.execute((trx) => new EditorialThreadRepository(trx).deleteThread(threadId));
			await new Promise((resolve) => setTimeout(resolve, 100));
			releaseEdit();

			await expect(Promise.all([edits, deletion])).resolves.toBeDefined();
			expect(await threads.findThread(threadId)).toBeNull();
		},
	);

	it("deletes a thread for its author only while nobody else has a live comment on it", async () => {
		const solo = await createThread();
		const replied = await createThread();
		await threads.addComment({
			threadId: replied.threadId,
			authorId: LINUS,
			body: "Wait",
			now: now(),
		});

		expect(await threads.deleteThreadIfOnlyAuthor(solo.threadId, ADA)).toBe(true);
		expect(await threads.findThread(solo.threadId)).toBeNull();
		expect(await threads.deleteThreadIfOnlyAuthor(replied.threadId, ADA)).toBe(false);
		expect((await threads.getThread(replied.threadId))?.comments).toHaveLength(2);
	});

	it("deletes the thread when its last live comment is deleted", async () => {
		const { threadId, commentId } = await createThread();

		const threadDeleted = await threads.deleteComment({ commentId, threadId, now: now() });

		expect(threadDeleted).toBe(true);
		expect(await threads.findThread(threadId)).toBeNull();
		expect(await threads.findComment(commentId)).toBeNull();
	});

	it.runIf(dialect === "postgres")(
		"deletes the thread when its last two comments are deleted at once",
		async () => {
			const { threadId, commentId: first } = await createThread();
			const second = await threads.addComment({
				threadId,
				authorId: LINUS,
				body: "Here.",
				now: now(),
			});

			let releaseFirst!: () => void;
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let firstDeleted!: () => void;
			const firstStarted = new Promise<void>((resolve) => {
				firstDeleted = resolve;
			});
			const firstDelete = db.transaction().execute(async (trx) => {
				await new EditorialThreadRepository(trx).deleteComment({
					commentId: first,
					threadId,
					now: now(),
				});
				firstDeleted();
				await firstHeld;
			});
			await firstStarted;
			const secondDelete = db.transaction().execute((trx) =>
				new EditorialThreadRepository(trx).deleteComment({
					commentId: second,
					threadId,
					now: now(),
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			releaseFirst();
			await Promise.all([firstDelete, secondDelete]);

			expect(await threads.findThread(threadId)).toBeNull();
		},
	);

	it.runIf(dialect === "postgres")(
		"keeps a reply that commits while its thread's creator deletes the thread",
		async () => {
			const { threadId } = await createThread();

			let releaseReply!: () => void;
			const replyHeld = new Promise<void>((resolve) => {
				releaseReply = resolve;
			});
			let replyInserted!: () => void;
			const replyStarted = new Promise<void>((resolve) => {
				replyInserted = resolve;
			});
			let replyId = "";
			const reply = db.transaction().execute(async (trx) => {
				replyId = await new EditorialThreadRepository(trx).addComment({
					threadId,
					authorId: LINUS,
					body: "Wait, I have a source.",
					now: now(),
				});
				replyInserted();
				await replyHeld;
			});
			await replyStarted;
			const creatorDelete = db
				.transaction()
				.execute((trx) =>
					new EditorialThreadRepository(trx).deleteThreadIfOnlyAuthor(threadId, ADA),
				);
			await new Promise((resolve) => setTimeout(resolve, 100));
			releaseReply();
			const [, deleted] = await Promise.all([reply, creatorDelete]);

			expect(deleted).toBe(false);
			expect(await threads.findThread(threadId)).not.toBeNull();
			expect(await threads.findComment(replyId)).toMatchObject({
				authorId: LINUS,
				deletedAt: null,
			});
		},
	);

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
		const entry = await new ContentRepository(db).findById("post", entryId);

		await threads.updateAnchors({
			collection: "post",
			entryId,
			expected: { version: entry!.version, updatedAt: entry!.updatedAt },
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

	it.runIf(dialect === "postgres")(
		"stores anchors before a save that arrives while they wait for a thread",
		async () => {
			const { threadId } = await createThread();
			const content = new ContentRepository(db);
			const entry = await content.findById("post", entryId);
			const order: string[] = [];

			let releaseThread!: () => void;
			const threadHeld = new Promise<void>((resolve) => {
				releaseThread = resolve;
			});
			let markLocked!: () => void;
			const locked = new Promise<void>((resolve) => {
				markLocked = resolve;
			});
			const holder = db.transaction().execute(async (trx) => {
				await trx
					.updateTable("_emdash_editorial_threads")
					.set((eb) => ({ updated_at: eb.ref("updated_at") }))
					.where("id", "=", threadId)
					.execute();
				markLocked();
				await threadHeld;
			});
			await locked;
			const anchors = db
				.transaction()
				.execute((trx) =>
					new EditorialThreadRepository(trx).updateAnchors({
						collection: "post",
						entryId,
						expected: { version: entry!.version, updatedAt: entry!.updatedAt },
						updates: [
							{
								threadId,
								anchor: { ...TEXT_ANCHOR, start: 16, end: 21 },
								anchorState: "attached",
							},
						],
						now: now(),
					}),
				)
				.then(
					() => order.push("anchors stored"),
					() => order.push("anchors refused"),
				);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const save = content
				.update("post", entryId, { data: { title: "Saved" } })
				.then(() => order.push("entry saved"));
			await new Promise((resolve) => setTimeout(resolve, 100));
			releaseThread();
			await Promise.all([holder, anchors, save]);

			expect(order).not.toEqual(["entry saved", "anchors stored"]);
		},
	);

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
