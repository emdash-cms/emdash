import { z } from "zod";

import { cursorPaginationQuery } from "./common.js";

const FIELD_SLUG = /^[a-z][a-z0-9_]*$/;

export const EDITORIAL_COMMENT_MAX_LENGTH = 10_000;
export const EDITORIAL_QUOTE_MAX_LENGTH = 2_000;
export const EDITORIAL_CONTEXT_MAX_LENGTH = 64;

const fieldSlug = z.string().max(63).regex(FIELD_SLUG).meta({
	description: "A top-level field slug of the entry's collection",
});
const blockKey = z.string().min(1).max(128).meta({
	description: "The Portable Text `_key` of the block",
});

/**
 * Where a thread points. Offsets count UTF-16 code units in the concatenated
 * text of the block's spans.
 */
export const editorialAnchorSchema = z
	.discriminatedUnion("type", [
		z.object({ type: z.literal("entry") }),
		z.object({ type: z.literal("field"), field: fieldSlug }),
		z.object({ type: z.literal("block"), field: fieldSlug, blockKey }),
		z
			.object({
				type: z.literal("text"),
				field: fieldSlug,
				blockKey,
				start: z.number().int().min(0),
				end: z.number().int().min(1),
				quote: z.string().min(1).max(EDITORIAL_QUOTE_MAX_LENGTH),
				prefix: z.string().max(EDITORIAL_CONTEXT_MAX_LENGTH),
				suffix: z.string().max(EDITORIAL_CONTEXT_MAX_LENGTH),
			})
			.refine((anchor) => anchor.end - anchor.start === anchor.quote.length, {
				message: "end - start must equal the length of quote",
				path: ["end"],
			}),
	])
	.meta({ id: "EditorialAnchor" });

const commentBody = z
	.string()
	.trim()
	.min(1)
	.max(EDITORIAL_COMMENT_MAX_LENGTH)
	.meta({ description: "Plain text. Mention a user with `<@USER_ID>`." });

const rev = z.string().max(512).optional().meta({
	description:
		"The entry's `_rev` the client worked from. When sent and no longer current, the request fails with 409 CONFLICT.",
});

export const editorialThreadListQuery = cursorPaginationQuery.extend({
	status: z.enum(["open", "resolved", "all"]).optional().default("open"),
});

export const editorialThreadCreateBody = z
	.object({ _rev: rev, anchor: editorialAnchorSchema, body: commentBody })
	.meta({ id: "EditorialThreadCreateBody" });

export const editorialThreadUpdateBody = z
	.object({ status: z.enum(["open", "resolved"]) })
	.meta({ id: "EditorialThreadUpdateBody" });

export const editorialCommentBody = z
	.object({ body: commentBody })
	.meta({ id: "EditorialCommentBody" });

export const editorialAnchorsUpdateBody = z
	.object({
		_rev: rev,
		anchors: z
			.array(
				z.object({
					threadId: z.string().min(1).max(64),
					anchor: editorialAnchorSchema,
					anchorState: z.enum(["attached", "orphaned"]),
				}),
			)
			.min(1)
			.max(100),
	})
	.meta({ id: "EditorialAnchorsUpdateBody" });

const editorialPersonSchema = z
	.object({ id: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })
	.meta({ id: "EditorialPerson" });

export const editorialCommentSchema = z
	.object({
		id: z.string(),
		threadId: z.string(),
		author: editorialPersonSchema.nullable().meta({
			description: "`null` when the author's account was deleted",
		}),
		body: z.string().meta({ description: "Empty when the comment was deleted" }),
		createdAt: z.string(),
		editedAt: z.string().nullable(),
		deletedAt: z.string().nullable(),
		can: z.object({ edit: z.boolean(), delete: z.boolean() }).meta({
			description: "What the caller may do with this comment",
		}),
	})
	.meta({ id: "EditorialComment" });

export const editorialMentionableQuery = z.object({
	q: z.string().max(100).optional().default("").meta({
		description: "Text to match against display names. Empty lists the first users by name.",
	}),
});

export const editorialMentionableResponseSchema = z
	.object({ items: z.array(editorialPersonSchema).max(10) })
	.meta({ id: "EditorialMentionableResponse" });

export const editorialThreadSchema = z
	.object({
		id: z.string(),
		collection: z.string(),
		entryId: z.string(),
		anchor: editorialAnchorSchema,
		anchorState: z.enum(["attached", "orphaned"]),
		status: z.enum(["open", "resolved"]),
		createdBy: z.string().nullable(),
		resolvedBy: editorialPersonSchema.nullable(),
		resolvedAt: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
		comments: z.array(editorialCommentSchema),
		mentions: z.array(editorialPersonSchema).meta({
			description:
				"Users the comments mention, with their current names. Render each `<@USER_ID>` token with these; deleted users are left out.",
		}),
		can: z.object({ resolve: z.boolean(), delete: z.boolean() }).meta({
			description: "What the caller may do with this thread",
		}),
	})
	.meta({ id: "EditorialThread" });

export const editorialThreadListResponseSchema = z
	.object({ items: z.array(editorialThreadSchema), nextCursor: z.string().optional() })
	.meta({ id: "EditorialThreadListResponse" });

export const editorialThreadDeleteResponseSchema = z
	.object({ deleted: z.literal(true), threadId: z.string() })
	.meta({ id: "EditorialThreadDeleteResponse" });

export const editorialCommentDeleteResponseSchema = z
	.object({
		threadDeleted: z.boolean(),
		thread: editorialThreadSchema.nullable().meta({
			description: "The thread after the deletion, or `null` when it went with its last comment",
		}),
	})
	.meta({ id: "EditorialCommentDeleteResponse" });

export const editorialAnchorsUpdateResponseSchema = z
	.object({ updated: z.number().int() })
	.meta({ id: "EditorialAnchorsUpdateResponse" });

export type EditorialThreadCreateBody = z.infer<typeof editorialThreadCreateBody>;
export type EditorialAnchorsUpdateBody = z.infer<typeof editorialAnchorsUpdateBody>;
