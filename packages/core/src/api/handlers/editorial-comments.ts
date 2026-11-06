import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import {
	EditorialThreadRepository,
	type EditorialAnchor,
	type EditorialAnchorUpdate,
	type EditorialComment,
	type EditorialPerson,
	type EditorialThread,
	type EditorialThreadHead,
} from "../../database/repositories/editorial-threads.js";
import type { ContentItem } from "../../database/repositories/types.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import {
	EDITORIAL_MENTION_LIMIT,
	extractMentions,
	findEditorialUsers,
	searchMentionableUsers,
	type EditorialUser,
} from "../../editorial/mentions.js";
import type { EditorialCommentCreated } from "../../editorial/notifications.js";
import { entryEditAccess } from "../authorize.js";
import { ErrorCode } from "../errors.js";
import { validateRev } from "../rev.js";
import type { ApiResult } from "../types.js";

export interface EditorialActor {
	id: string;
	role: RoleLevel;
}

export interface EditorialCommentView extends EditorialComment {
	can: { edit: boolean; delete: boolean };
}

export interface EditorialThreadView extends Omit<EditorialThread, "comments"> {
	comments: EditorialCommentView[];
	/** Users the comments mention, with their current names. Deleted users are left out. */
	mentions: EditorialPerson[];
	can: { resolve: boolean; delete: boolean };
}

/** Called once a new comment is committed, to send its notifications. */
export type EditorialCommentCreatedHook = (created: EditorialCommentCreated) => void;

/** Identifies the entry from the route: `id` may be an ID or a slug. */
export interface EditorialEntryRef {
	collection: string;
	id: string;
	locale?: string;
}

interface Entry {
	collection: string;
	item: ContentItem;
	fieldTypes: Map<string, string>;
}

type Failure = Extract<ApiResult<never>, { success: false }>;

function fail(code: string, message: string): Failure {
	return { success: false, error: { code, message } };
}

function isFailure<T>(value: T | Failure): value is Failure {
	return typeof value === "object" && value !== null && "success" in value && !value.success;
}

const threadNotFound = () => fail(ErrorCode.NOT_FOUND, "Thread not found");

async function loadEntry(db: Kysely<Database>, ref: EditorialEntryRef): Promise<Entry | Failure> {
	const fields = await db
		.selectFrom("_emdash_collections as c")
		.leftJoin("_emdash_fields as f", "f.collection_id", "c.id")
		.select(["f.slug", "f.type"])
		.where("c.slug", "=", ref.collection)
		.execute();
	if (fields.length === 0) {
		return fail(ErrorCode.COLLECTION_NOT_FOUND, `Collection '${ref.collection}' not found`);
	}
	const item = await new ContentRepository(db).findByIdOrSlugIncludingTrashed(
		ref.collection,
		ref.id,
		ref.locale,
	);
	if (!item) return fail(ErrorCode.NOT_FOUND, "Content not found");

	const fieldTypes = new Map<string, string>();
	for (const field of fields) {
		if (field.slug && field.type) fieldTypes.set(field.slug, field.type);
	}
	return { collection: ref.collection, item, fieldTypes };
}

/** Writes need a live entry, and a `_rev` that is still current when one is sent. */
async function checkWritable(
	db: Kysely<Database>,
	entry: Entry,
	rev?: string,
): Promise<Failure | null> {
	if (await new ContentRepository(db).isTrashed(entry.collection, entry.item.id)) {
		return fail(ErrorCode.CONFLICT, "Restore the entry from the trash before commenting on it");
	}
	const revCheck = validateRev(rev, entry.item);
	if (!revCheck.valid) return fail(ErrorCode.CONFLICT, revCheck.message);
	return null;
}

function checkAnchor(entry: Entry, anchor: EditorialAnchor): Failure | null {
	if (anchor.type === "entry") return null;
	const type = entry.fieldTypes.get(anchor.field);
	if (!type) return fail(ErrorCode.VALIDATION_ERROR, `Unknown field '${anchor.field}'`);
	if (anchor.type !== "field" && type !== "portableText") {
		return fail(
			ErrorCode.VALIDATION_ERROR,
			`Field '${anchor.field}' has no blocks to anchor a comment to`,
		);
	}
	return null;
}

async function loadThread(
	db: Kysely<Database>,
	entry: Entry,
	threadId: string,
): Promise<EditorialThreadHead | Failure> {
	const thread = await new EditorialThreadRepository(db).findThread(threadId);
	if (!thread || thread.collection !== entry.collection || thread.entryId !== entry.item.id) {
		return threadNotFound();
	}
	return thread;
}

function isManager(actor: EditorialActor): boolean {
	return hasPermission(actor, "editorial:manage");
}

/**
 * Resolving or reopening is open to editors, the thread's creator, and whoever
 * may edit the entry as its owner.
 */
function canResolve(actor: EditorialActor, entry: Entry, thread: { createdBy: string | null }) {
	if (isManager(actor) || thread.createdBy === actor.id) return true;
	const authorId = entry.item.authorId ?? "";
	return (
		authorId !== "" &&
		authorId === actor.id &&
		entryEditAccess(actor, { authorId, status: entry.item.status }) !== null
	);
}

/** A creator may delete a thread only while nobody else has replied. */
function canDeleteThread(
	actor: EditorialActor,
	thread: { createdBy: string | null },
	liveAuthorIds: Iterable<string | null>,
): boolean {
	if (isManager(actor)) return true;
	if (thread.createdBy !== actor.id) return false;
	for (const authorId of liveAuthorIds) {
		if (authorId !== actor.id) return false;
	}
	return true;
}

/** Every mentioned user must exist and be allowed to take part in editorial threads. */
async function checkMentions(db: Kysely<Database>, body: string): Promise<Failure | null> {
	const ids = extractMentions(body);
	if (ids.length === 0) return null;
	if (ids.length > EDITORIAL_MENTION_LIMIT) {
		return fail(
			ErrorCode.VALIDATION_ERROR,
			`A comment can mention at most ${EDITORIAL_MENTION_LIMIT} people`,
		);
	}
	const users = await findEditorialUsers(db, ids);
	const invalid = ids.find((id) => !users.get(id)?.canComment);
	if (invalid) {
		return fail(
			ErrorCode.VALIDATION_ERROR,
			`<@${invalid}> can't be mentioned in editorial comments`,
		);
	}
	return null;
}

function mentionIds(thread: EditorialThread): string[] {
	return thread.comments.flatMap((comment) => extractMentions(comment.body));
}

async function mentionedUsers(
	db: Kysely<Database>,
	threads: EditorialThread[],
): Promise<Map<string, EditorialUser>> {
	const ids = threads.flatMap(mentionIds);
	return ids.length === 0 ? new Map() : findEditorialUsers(db, ids);
}

function toView(
	actor: EditorialActor,
	entry: Entry,
	thread: EditorialThread,
	users: Map<string, EditorialUser>,
): EditorialThreadView {
	const mentions: EditorialPerson[] = [];
	for (const id of new Set(mentionIds(thread))) {
		const user = users.get(id);
		if (user) mentions.push({ id: user.id, name: user.name, avatarUrl: user.avatarUrl });
	}
	const liveAuthors = thread.comments
		.filter((comment) => comment.deletedAt === null)
		.map((comment) => comment.author?.id ?? null);
	return {
		...thread,
		comments: thread.comments.map((comment) => {
			const live = comment.deletedAt === null;
			const mine = comment.author?.id === actor.id;
			return {
				...comment,
				can: { edit: live && mine, delete: live && (mine || isManager(actor)) },
			};
		}),
		mentions,
		can: {
			resolve: canResolve(actor, entry, thread),
			delete: canDeleteThread(actor, thread, liveAuthors),
		},
	};
}

async function threadView(
	db: Kysely<Database>,
	actor: EditorialActor,
	entry: Entry,
	threadId: string,
): Promise<ApiResult<EditorialThreadView>> {
	const thread = await new EditorialThreadRepository(db).getThread(threadId);
	if (!thread) return threadNotFound();
	return { success: true, data: toView(actor, entry, thread, await mentionedUsers(db, [thread])) };
}

async function run<T>(
	label: string,
	fn: () => Promise<ApiResult<T> | Failure>,
): Promise<ApiResult<T>> {
	try {
		return await fn();
	} catch (error) {
		console.error(`[editorial-comments] ${label} failed:`, error);
		return fail(ErrorCode.EDITORIAL_COMMENT_ERROR, `Failed to ${label}`);
	}
}

const now = () => new Date().toISOString();

export function handleEditorialThreadList(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	options: { status: "open" | "resolved" | "all"; limit: number; cursor?: string },
): Promise<ApiResult<{ items: EditorialThreadView[]; nextCursor?: string }>> {
	return run("list editorial threads", async () => {
		const entry = await loadEntry(db, ref);
		if (isFailure(entry)) return entry;
		const page = await new EditorialThreadRepository(db).listForEntry(
			entry.collection,
			entry.item.id,
			{
				status: options.status === "all" ? undefined : options.status,
				limit: options.limit,
				cursor: options.cursor,
			},
		);
		const users = await mentionedUsers(db, page.items);
		return {
			success: true,
			data: {
				items: page.items.map((thread) => toView(actor, entry, thread, users)),
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			},
		};
	});
}

export function handleEditorialThreadCreate(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	input: { _rev?: string; anchor: EditorialAnchor; body: string },
	onCreated?: EditorialCommentCreatedHook,
): Promise<ApiResult<EditorialThreadView>> {
	return run("create the editorial thread", async () => {
		const created: { value?: EditorialCommentCreated } = {};
		const result = await withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const refused =
				(await checkWritable(trx, entry, input._rev)) ??
				checkAnchor(entry, input.anchor) ??
				(await checkMentions(trx, input.body));
			if (refused) return refused;

			created.value = await new EditorialThreadRepository(trx).createThread({
				collection: entry.collection,
				entryId: entry.item.id,
				anchor: input.anchor,
				createdBy: actor.id,
				body: input.body,
				now: now(),
			});
			return threadView(trx, actor, entry, created.value.threadId);
		});
		if (result.success && created.value) onCreated?.(created.value);
		return result;
	});
}

export function handleEditorialThreadUpdate(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	threadId: string,
	input: { status: "open" | "resolved" },
): Promise<ApiResult<EditorialThreadView>> {
	return run("update the editorial thread", () =>
		withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const thread = await loadThread(trx, entry, threadId);
			if (isFailure(thread)) return thread;
			if (!canResolve(actor, entry, thread)) {
				return fail(ErrorCode.FORBIDDEN, "You can't change this thread's status");
			}
			const refused = await checkWritable(trx, entry);
			if (refused) return refused;

			if (thread.status !== input.status) {
				await new EditorialThreadRepository(trx).setStatus({
					threadId,
					status: input.status,
					userId: actor.id,
					now: now(),
				});
			}
			return threadView(trx, actor, entry, threadId);
		}),
	);
}

export function handleEditorialThreadDelete(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	threadId: string,
): Promise<ApiResult<{ deleted: true; threadId: string }>> {
	return run("delete the editorial thread", () =>
		withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const thread = await loadThread(trx, entry, threadId);
			if (isFailure(thread)) return thread;
			const threads = new EditorialThreadRepository(trx);
			if (!canDeleteThread(actor, thread, await threads.listCommentAuthors(threadId))) {
				return fail(ErrorCode.FORBIDDEN, "You can't delete this thread");
			}

			await threads.deleteThread(threadId);
			return { success: true, data: { deleted: true, threadId } };
		}),
	);
}

export function handleEditorialCommentCreate(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	threadId: string,
	input: { body: string },
	onCreated?: EditorialCommentCreatedHook,
): Promise<ApiResult<EditorialThreadView>> {
	return run("add the comment", async () => {
		const created: { value?: EditorialCommentCreated } = {};
		const result = await withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const thread = await loadThread(trx, entry, threadId);
			if (isFailure(thread)) return thread;
			const refused = (await checkWritable(trx, entry)) ?? (await checkMentions(trx, input.body));
			if (refused) return refused;

			const commentId = await new EditorialThreadRepository(trx).addComment({
				threadId,
				authorId: actor.id,
				body: input.body,
				now: now(),
			});
			created.value = { threadId, commentId };
			return threadView(trx, actor, entry, threadId);
		});
		if (result.success && created.value) onCreated?.(created.value);
		return result;
	});
}

async function loadComment(
	db: Kysely<Database>,
	threadId: string,
	commentId: string,
): Promise<{ authorId: string | null } | Failure> {
	const comment = await new EditorialThreadRepository(db).findComment(commentId);
	if (!comment || comment.threadId !== threadId || comment.deletedAt !== null) {
		return fail(ErrorCode.NOT_FOUND, "Comment not found");
	}
	return comment;
}

export function handleEditorialCommentUpdate(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	threadId: string,
	commentId: string,
	input: { body: string },
): Promise<ApiResult<EditorialThreadView>> {
	return run("edit the comment", () =>
		withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const thread = await loadThread(trx, entry, threadId);
			if (isFailure(thread)) return thread;
			const comment = await loadComment(trx, threadId, commentId);
			if (isFailure(comment)) return comment;
			if (comment.authorId !== actor.id) {
				return fail(ErrorCode.FORBIDDEN, "Only its author can edit a comment");
			}
			const refused = (await checkWritable(trx, entry)) ?? (await checkMentions(trx, input.body));
			if (refused) return refused;

			await new EditorialThreadRepository(trx).editComment({
				commentId,
				threadId,
				body: input.body,
				now: now(),
			});
			return threadView(trx, actor, entry, threadId);
		}),
	);
}

export function handleEditorialCommentDelete(
	db: Kysely<Database>,
	actor: EditorialActor,
	ref: EditorialEntryRef,
	threadId: string,
	commentId: string,
): Promise<ApiResult<{ threadDeleted: boolean; thread: EditorialThreadView | null }>> {
	return run<{ threadDeleted: boolean; thread: EditorialThreadView | null }>(
		"delete the comment",
		() =>
			withTransaction(db, async (trx) => {
				const entry = await loadEntry(trx, ref);
				if (isFailure(entry)) return entry;
				const thread = await loadThread(trx, entry, threadId);
				if (isFailure(thread)) return thread;
				const comment = await loadComment(trx, threadId, commentId);
				if (isFailure(comment)) return comment;
				if (comment.authorId !== actor.id && !isManager(actor)) {
					return fail(ErrorCode.FORBIDDEN, "You can't delete this comment");
				}

				const threadDeleted = await new EditorialThreadRepository(trx).deleteComment({
					commentId,
					threadId,
					now: now(),
				});
				if (threadDeleted) return { success: true, data: { threadDeleted, thread: null } };
				const view = await threadView(trx, actor, entry, threadId);
				if (!view.success) return view;
				return { success: true, data: { threadDeleted, thread: view.data } };
			}),
	);
}

/**
 * Stores anchors the editor recomputed after the entry's content changed.
 * Anyone who can comment may send them, since any editor's client may be the
 * one that noticed the change.
 */
export function handleEditorialAnchorsUpdate(
	db: Kysely<Database>,
	ref: EditorialEntryRef,
	input: { _rev?: string; anchors: EditorialAnchorUpdate[] },
): Promise<ApiResult<{ updated: number }>> {
	return run("update the comment anchors", () =>
		withTransaction(db, async (trx) => {
			const entry = await loadEntry(trx, ref);
			if (isFailure(entry)) return entry;
			const refused = await checkWritable(trx, entry, input._rev);
			if (refused) return refused;
			for (const update of input.anchors) {
				const invalid = checkAnchor(entry, update.anchor);
				if (invalid) return invalid;
			}

			const updated = await new EditorialThreadRepository(trx).updateAnchors({
				collection: entry.collection,
				entryId: entry.item.id,
				updates: input.anchors,
				now: now(),
			});
			return { success: true, data: { updated } };
		}),
	);
}

/**
 * Users who may be mentioned on the entry's threads. Per entry, so that a
 * future collection-scoped permission model can narrow it.
 */
export function handleEditorialMentionable(
	db: Kysely<Database>,
	ref: EditorialEntryRef,
	query: string,
): Promise<ApiResult<{ items: EditorialPerson[] }>> {
	return run("list mentionable users", async () => {
		const entry = await loadEntry(db, ref);
		if (isFailure(entry)) return entry;
		return { success: true, data: { items: await searchMentionableUsers(db, query) } };
	});
}
