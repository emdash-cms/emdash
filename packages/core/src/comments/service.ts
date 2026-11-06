/**
 * Comment Service
 *
 * Orchestrates comment creation through the hook pipeline:
 *   1. Run comment:beforeCreate pipeline (transform/reject)
 *   2. Query priorApprovedCount for first-time moderation
 *   3. Invoke comment:moderate exclusive hook (or built-in fallback)
 *   4. Save comment with determined status
 *   5. Fire comment:afterCreate (fire-and-forget)
 *
 * Also handles admin moderation (status changes) with afterModerate hooks.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Kysely } from "kysely";

import { CommentRepository } from "../database/repositories/comment.js";
import type { Comment, CommentStatus } from "../database/repositories/comment.js";
import type { Database } from "../database/types.js";
import type {
	CollectionCommentSettings,
	CommentAfterCreateEvent,
	CommentAfterModerateEvent,
	CommentBeforeCreateEvent,
	CommentModerateEvent,
	ModerationDecision,
	StoredComment,
} from "../plugins/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentCreateInput {
	collection: string;
	contentId: string;
	parentId?: string | null;
	authorName: string;
	authorEmail: string;
	authorUserId?: string | null;
	body: string;
	ipHash?: string | null;
	userAgent?: string | null;
}

export interface CommentCreateResult {
	comment: Comment;
	decision: ModerationDecision;
}

/**
 * Hook runner interface — injected from the runtime so the service
 * doesn't need to know about the hook pipeline internals.
 */
export interface CommentHookRunner {
	/** Run comment:beforeCreate pipeline. Returns modified event or false. */
	runBeforeCreate(event: CommentBeforeCreateEvent): Promise<CommentBeforeCreateEvent | false>;

	/** Run comment:moderate exclusive hook. Returns moderation decision. */
	runModerate(event: CommentModerateEvent): Promise<ModerationDecision>;

	/** Fire comment:afterCreate (fire-and-forget). */
	fireAfterCreate(event: CommentAfterCreateEvent): void;

	/** Run comment:afterModerate after a successful transition. */
	fireAfterModerate(event: CommentAfterModerateEvent): void | Promise<void>;
}

export type CommentModerationOrigin =
	| { source: "admin"; userId: string; name: string | null }
	| { source: "plugin"; pluginId: string };

export class CommentStatusConflictError extends Error {
	readonly code = "COMMENT_STATUS_CONFLICT";
	readonly currentStatus: CommentStatus;

	constructor(currentStatus: CommentStatus) {
		super("Comment status changed; read the current comment before retrying");
		this.name = "CommentStatusConflictError";
		this.currentStatus = currentStatus;
	}
}

const commentModerationALS = new AsyncLocalStorage<ReadonlySet<string>>();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Create a comment through the full hook pipeline.
 *
 * Returns null if the comment was rejected by a beforeCreate handler.
 */
export async function createComment(
	db: Kysely<Database>,
	input: CommentCreateInput,
	collectionSettings: CollectionCommentSettings,
	hooks: CommentHookRunner,
	contentInfo?: {
		id: string;
		collection: string;
		slug: string;
		title?: string;
		author?: { id: string; name: string | null; email: string };
	},
): Promise<CommentCreateResult | null> {
	const repo = new CommentRepository(db);

	// 1. Build the beforeCreate event
	const beforeCreateEvent: CommentBeforeCreateEvent = {
		comment: {
			collection: input.collection,
			contentId: input.contentId,
			parentId: input.parentId ?? null,
			authorName: input.authorName,
			authorEmail: input.authorEmail,
			authorUserId: input.authorUserId ?? null,
			body: input.body,
			ipHash: input.ipHash ?? null,
			userAgent: input.userAgent ?? null,
		},
		metadata: {},
	};

	// 2. Run comment:beforeCreate pipeline
	const result = await hooks.runBeforeCreate(beforeCreateEvent);
	if (result === false) {
		return null; // Rejected
	}

	const event = result;

	// 3. Query prior approved count for first-time moderation
	const priorApprovedCount = await repo.countApprovedByEmail(event.comment.authorEmail);

	// 4. Run comment:moderate exclusive hook
	const moderateEvent: CommentModerateEvent = {
		comment: event.comment,
		metadata: event.metadata,
		collectionSettings,
		priorApprovedCount,
	};

	const decision = await hooks.runModerate(moderateEvent);

	// 5. Save comment with determined status
	const comment = await repo.create({
		collection: event.comment.collection,
		contentId: event.comment.contentId,
		parentId: event.comment.parentId,
		authorName: event.comment.authorName,
		authorEmail: event.comment.authorEmail,
		authorUserId: event.comment.authorUserId,
		body: event.comment.body,
		status: decision.status,
		ipHash: event.comment.ipHash,
		userAgent: event.comment.userAgent,
		moderationMetadata: Object.keys(event.metadata).length > 0 ? event.metadata : null,
	});

	// 6. Fire comment:afterCreate (fire-and-forget)
	if (contentInfo) {
		const afterEvent: CommentAfterCreateEvent = {
			comment: commentToStored(comment),
			metadata: event.metadata,
			content: {
				id: contentInfo.id,
				collection: contentInfo.collection,
				slug: contentInfo.slug,
				title: contentInfo.title,
			},
			contentAuthor: contentInfo.author,
		};
		hooks.fireAfterCreate(afterEvent);
	}

	return { comment, decision };
}

/**
 * Admin moderation — change a comment's status.
 * Fires comment:afterModerate hook.
 */
export async function moderateComment(
	db: Kysely<Database>,
	id: string,
	newStatus: CommentStatus,
	expectedStatus: CommentStatus,
	origin: CommentModerationOrigin,
	hooks: CommentHookRunner,
	onApproved?: (comment: Comment) => void | Promise<void>,
): Promise<Comment | null> {
	const active = commentModerationALS.getStore();
	if (active?.has(id)) throw new Error("Recursive comment moderation is not allowed");
	const next = new Set(active);
	next.add(id);
	return commentModerationALS.run(next, () =>
		moderateCommentWithinGuard(db, id, newStatus, expectedStatus, origin, hooks, onApproved),
	);
}

async function moderateCommentWithinGuard(
	db: Kysely<Database>,
	id: string,
	newStatus: CommentStatus,
	expectedStatus: CommentStatus,
	origin: CommentModerationOrigin,
	hooks: CommentHookRunner,
	onApproved?: (comment: Comment) => void | Promise<void>,
): Promise<Comment | null> {
	const repo = new CommentRepository(db);
	const result = await repo.updateStatusIf(id, newStatus, expectedStatus);
	if (result.state === "not_found") return null;
	if (result.state === "conflict") throw new CommentStatusConflictError(result.comment.status);
	if (result.state === "unchanged") return result.comment;
	const updated = result.comment;

	if (newStatus === "approved") await onApproved?.(updated);

	// Run comment:afterModerate after a successful transition
	const afterEvent: CommentAfterModerateEvent = {
		comment: commentToStored(updated),
		previousStatus: expectedStatus,
		newStatus,
		moderator:
			origin.source === "admin"
				? { id: origin.userId, name: origin.name }
				: { id: origin.pluginId, name: null },
		origin:
			origin.source === "admin"
				? { source: "admin", userId: origin.userId }
				: { source: "plugin", pluginId: origin.pluginId },
	};
	await hooks.fireAfterModerate(afterEvent);

	return updated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commentToStored(comment: Comment): StoredComment {
	return {
		id: comment.id,
		collection: comment.collection,
		contentId: comment.contentId,
		parentId: comment.parentId,
		authorName: comment.authorName,
		authorEmail: comment.authorEmail,
		authorUserId: comment.authorUserId,
		body: comment.body,
		status: comment.status,
		moderationMetadata: comment.moderationMetadata,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
	};
}
