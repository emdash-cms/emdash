import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentDelete } from "../../../src/api/handlers/content.js";
import {
	handleEditorialAnchorsUpdate,
	handleEditorialCommentCreate,
	handleEditorialCommentDelete,
	handleEditorialCommentUpdate,
	handleEditorialThreadCreate,
	handleEditorialThreadDelete,
	handleEditorialThreadList,
	handleEditorialThreadUpdate,
	type EditorialActor,
	type EditorialEntryRef,
	type EditorialThreadView,
} from "../../../src/api/handlers/editorial-comments.js";
import { encodeRev } from "../../../src/api/rev.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { EditorialAnchor } from "../../../src/database/repositories/editorial-threads.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const OWNER: EditorialActor = { id: "user-owner", role: Role.CONTRIBUTOR };
const REVIEWER: EditorialActor = { id: "user-reviewer", role: Role.CONTRIBUTOR };
const BYSTANDER: EditorialActor = { id: "user-bystander", role: Role.CONTRIBUTOR };
const EDITOR: EditorialActor = { id: "user-editor", role: Role.EDITOR };

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

function expectData<T>(
	result: { success: true; data: T } | { success: false; error: { code: string } },
): T {
	if (!result.success) throw new Error(`Expected success, got ${result.error.code}`);
	return result.data;
}

describeEachDialect("editorial comment handlers", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let entry: EditorialEntryRef;
	let otherEntry: EditorialEntryRef;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		await db
			.insertInto("users")
			.values(
				[OWNER, REVIEWER, BYSTANDER, EDITOR].map((actor) => ({
					id: actor.id,
					email: `${actor.id}@example.com`,
					name: actor.id,
					role: actor.role,
					email_verified: 1,
					avatar_url: null,
					data: null,
				})),
			)
			.execute();
		const content = new ContentRepository(db);
		const mine = await content.create({
			type: "post",
			slug: "mine",
			data: { title: "Mine" },
			authorId: OWNER.id,
		});
		const theirs = await content.create({
			type: "post",
			data: { title: "Theirs" },
			authorId: BYSTANDER.id,
		});
		entry = { collection: "post", id: mine.id };
		otherEntry = { collection: "post", id: theirs.id };
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function startThread(
		actor = REVIEWER,
		ref = entry,
		anchor: EditorialAnchor = TEXT_ANCHOR,
	): Promise<EditorialThreadView> {
		return expectData(
			await handleEditorialThreadCreate(db, actor, ref, { anchor, body: "Source?" }),
		);
	}

	async function currentRev(): Promise<string> {
		const item = await new ContentRepository(db).findById("post", entry.id);
		return encodeRev(item!);
	}

	it("starts a thread that its creator may resolve and delete", async () => {
		const thread = await startThread();

		expect(thread).toMatchObject({
			anchor: TEXT_ANCHOR,
			status: "open",
			createdBy: REVIEWER.id,
			comments: [
				{ body: "Source?", author: { id: REVIEWER.id }, can: { edit: true, delete: true } },
			],
			can: { resolve: true, delete: true },
		});
	});

	it("finds the entry by slug", async () => {
		const thread = await startThread(REVIEWER, { collection: "post", id: "mine", locale: "en" });

		expect(thread.entryId).toBe(entry.id);
	});

	it("lists threads with what the caller may do", async () => {
		const { id } = await startThread();

		const asBystander = expectData(
			await handleEditorialThreadList(db, BYSTANDER, entry, { status: "open", limit: 50 }),
		);
		const asEditor = expectData(
			await handleEditorialThreadList(db, EDITOR, entry, { status: "open", limit: 50 }),
		);

		expect(asBystander.items.map((t) => t.id)).toEqual([id]);
		expect(asBystander.items[0]).toMatchObject({
			can: { resolve: false, delete: false },
			comments: [{ can: { edit: false, delete: false } }],
		});
		expect(asEditor.items[0]).toMatchObject({
			can: { resolve: true, delete: true },
			comments: [{ can: { edit: false, delete: true } }],
		});
	});

	it("rejects an unknown collection", async () => {
		const result = await handleEditorialThreadList(
			db,
			REVIEWER,
			{ collection: "nope", id: entry.id },
			{ status: "all", limit: 50 },
		);

		expect(result).toMatchObject({ success: false, error: { code: "COLLECTION_NOT_FOUND" } });
	});

	it("rejects anchors that don't fit the collection's fields", async () => {
		const unknownField = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			anchor: { type: "field", field: "subtitle" },
			body: "Hm",
		});
		const blockInString = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			anchor: { type: "block", field: "title", blockKey: "b1" },
			body: "Hm",
		});

		expect(unknownField).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		expect(blockInString).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("accepts a current or missing _rev and refuses a stale one", async () => {
		const rev = await currentRev();
		await new ContentRepository(db).update("post", entry.id, { data: { title: "Changed" } });

		const stale = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			_rev: rev,
			anchor: { type: "entry" },
			body: "Hi",
		});
		const current = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			_rev: await currentRev(),
			anchor: { type: "entry" },
			body: "Hi",
		});
		const blind = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			anchor: { type: "entry" },
			body: "Hi",
		});

		expect(stale).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(current.success).toBe(true);
		expect(blind.success).toBe(true);
	});

	it("shows threads on a trashed entry but refuses new comments", async () => {
		const { id } = await startThread();
		await handleContentDelete(db, "post", entry.id);

		const list = await handleEditorialThreadList(db, REVIEWER, entry, {
			status: "open",
			limit: 50,
		});
		const reply = await handleEditorialCommentCreate(db, REVIEWER, entry, id, { body: "Hi" });

		expect(expectData(list).items.map((t) => t.id)).toEqual([id]);
		expect(reply).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});

	it("hides a thread from routes for another entry", async () => {
		const { id, comments } = await startThread(REVIEWER, otherEntry);
		const commentId = comments[0]!.id;

		const results = [
			await handleEditorialThreadUpdate(db, EDITOR, entry, id, { status: "resolved" }),
			await handleEditorialThreadDelete(db, EDITOR, entry, id),
			await handleEditorialCommentCreate(db, EDITOR, entry, id, { body: "Hi" }),
			await handleEditorialCommentUpdate(db, REVIEWER, entry, id, commentId, { body: "Hi" }),
			await handleEditorialCommentDelete(db, EDITOR, entry, id, commentId),
		];

		for (const result of results) {
			expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
		}
		const [thread] = expectData(
			await handleEditorialThreadList(db, EDITOR, otherEntry, { status: "all", limit: 50 }),
		).items;
		expect(thread).toMatchObject({ status: "open", comments: [{ body: "Source?" }] });
	});

	it("lets the creator, the entry's owner and an editor resolve a thread, but nobody else", async () => {
		const { id } = await startThread();

		const bystander = await handleEditorialThreadUpdate(db, BYSTANDER, entry, id, {
			status: "resolved",
		});
		expect(bystander).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });

		for (const actor of [REVIEWER, OWNER, EDITOR]) {
			// oxlint-disable-next-line no-await-in-loop -- each actor resolves after the previous reopen
			const resolved = await handleEditorialThreadUpdate(db, actor, entry, id, {
				status: "resolved",
			});
			expect(expectData(resolved)).toMatchObject({
				status: "resolved",
				resolvedBy: { id: actor.id },
			});
			// oxlint-disable-next-line no-await-in-loop -- reopen before the next actor tries
			await handleEditorialThreadUpdate(db, EDITOR, entry, id, { status: "open" });
		}
	});

	it("stops the owner resolving once they can no longer edit the entry", async () => {
		const { id } = await startThread();
		await new ContentRepository(db).update("post", entry.id, { status: "published" });

		const result = await handleEditorialThreadUpdate(db, OWNER, entry, id, {
			status: "resolved",
		});

		expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
	});

	it("reopens a resolved thread on reply", async () => {
		const { id } = await startThread();
		await handleEditorialThreadUpdate(db, REVIEWER, entry, id, { status: "resolved" });

		const thread = expectData(
			await handleEditorialCommentCreate(db, OWNER, entry, id, { body: "Not done" }),
		);

		expect(thread).toMatchObject({ status: "open", resolvedBy: null });
		expect(thread.comments.map((c) => c.body)).toEqual(["Source?", "Not done"]);
	});

	it("lets the creator delete a thread only until someone else replies", async () => {
		const solo = await startThread();
		const replied = await startThread();
		await handleEditorialCommentCreate(db, OWNER, entry, replied.id, { body: "Done" });

		const soloResult = await handleEditorialThreadDelete(db, REVIEWER, entry, solo.id);
		const repliedResult = await handleEditorialThreadDelete(db, REVIEWER, entry, replied.id);
		const editorResult = await handleEditorialThreadDelete(db, EDITOR, entry, replied.id);

		expect(soloResult).toMatchObject({ success: true, data: { deleted: true } });
		expect(repliedResult).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		expect(editorResult).toMatchObject({ success: true, data: { deleted: true } });
	});

	it("lets only a comment's author edit it", async () => {
		const { id, comments } = await startThread();
		const commentId = comments[0]!.id;

		const byEditor = await handleEditorialCommentUpdate(db, EDITOR, entry, id, commentId, {
			body: "Rewritten",
		});
		const byAuthor = await handleEditorialCommentUpdate(db, REVIEWER, entry, id, commentId, {
			body: "Source, please?",
		});

		expect(byEditor).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		const comment = expectData(byAuthor).comments[0]!;
		expect(comment.body).toBe("Source, please?");
		expect(comment.editedAt).not.toBeNull();
	});

	it("lets a comment's author or an editor delete it", async () => {
		const { id } = await startThread();
		const withReply = expectData(
			await handleEditorialCommentCreate(db, OWNER, entry, id, { body: "Linked" }),
		);
		const replyId = withReply.comments[1]!.id;

		const byBystander = await handleEditorialCommentDelete(db, BYSTANDER, entry, id, replyId);
		const byEditor = await handleEditorialCommentDelete(db, EDITOR, entry, id, replyId);

		expect(byBystander).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		expect(expectData(byEditor)).toMatchObject({
			threadDeleted: false,
			thread: {
				comments: [{ body: "Source?" }, { body: "", can: { edit: false, delete: false } }],
			},
		});
	});

	it("deletes the thread with its last live comment", async () => {
		const { id, comments } = await startThread();

		const result = await handleEditorialCommentDelete(db, REVIEWER, entry, id, comments[0]!.id);

		expect(result).toMatchObject({ success: true, data: { threadDeleted: true, thread: null } });
		const list = expectData(
			await handleEditorialThreadList(db, REVIEWER, entry, { status: "all", limit: 50 }),
		);
		expect(list.items).toEqual([]);
	});

	it("stores recomputed anchors for the entry's threads only", async () => {
		const mine = await startThread();
		const theirs = await startThread(REVIEWER, otherEntry);
		const moved: EditorialAnchor = { ...TEXT_ANCHOR, start: 10, end: 15 };

		const result = await handleEditorialAnchorsUpdate(db, entry, {
			_rev: await currentRev(),
			anchors: [
				{ threadId: mine.id, anchor: moved, anchorState: "attached" },
				{ threadId: theirs.id, anchor: moved, anchorState: "orphaned" },
			],
		});

		expect(result).toMatchObject({ success: true, data: { updated: 1 } });
		const [thread] = expectData(
			await handleEditorialThreadList(db, REVIEWER, entry, { status: "open", limit: 50 }),
		).items;
		expect(thread!.anchor).toEqual(moved);
		const [other] = expectData(
			await handleEditorialThreadList(db, REVIEWER, otherEntry, { status: "open", limit: 50 }),
		).items;
		expect(other!.anchor).toEqual(TEXT_ANCHOR);
	});

	it("refuses recomputed anchors made from a stale entry", async () => {
		const { id } = await startThread();
		const rev = await currentRev();
		await new ContentRepository(db).update("post", entry.id, { data: { title: "Changed" } });

		const result = await handleEditorialAnchorsUpdate(db, entry, {
			_rev: rev,
			anchors: [{ threadId: id, anchor: TEXT_ANCHOR, anchorState: "orphaned" }],
		});

		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});
});
