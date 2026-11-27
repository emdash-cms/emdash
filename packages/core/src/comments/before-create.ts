import { isRecord } from "../plugin-utils.js";
import type { CommentBeforeCreateEvent } from "../plugins/types.js";

/**
 * Merge a comment:beforeCreate handler's result into the event it was given.
 *
 * Only the commenter's name, email address and body, and the metadata, are
 * taken from the result. The target, account, IP hash and user agent were
 * established by the caller and are kept.
 */
export function applyCommentBeforeCreateResult(
	event: CommentBeforeCreateEvent,
	result: unknown,
): CommentBeforeCreateEvent {
	// Sandboxed handlers can return any JSON value.
	if (!isRecord(result)) return event;
	const comment = isRecord(result.comment) ? result.comment : {};

	return {
		comment: {
			...event.comment,
			authorName: stringOr(comment.authorName, event.comment.authorName),
			authorEmail: stringOr(comment.authorEmail, event.comment.authorEmail),
			body: stringOr(comment.body, event.comment.body),
		},
		metadata: isRecord(result.metadata) ? result.metadata : event.metadata,
	};
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}
