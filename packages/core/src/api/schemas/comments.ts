import { z } from "zod";

// ---------------------------------------------------------------------------
// Comments: Input schemas
// ---------------------------------------------------------------------------

export const createCommentBody = z
	.object({
		authorName: z.string().min(1).max(100),
		authorEmail: z.string().email(),
		body: z.string().min(1).max(5000),
		parentId: z.string().optional(),
		/** Honeypot field — hidden in the form, filled only by bots */
		website_url: z.string().optional(),
	})
	.meta({ id: "CreateCommentBody" });

export const commentStatusBody = z
	.object({
		status: z.enum(["approved", "pending", "spam", "trash"]),
	})
	.meta({ id: "CommentStatusBody" });

export const commentBulkBody = z
	.object({
		ids: z.array(z.string().min(1)).min(1).max(100),
		action: z.enum(["approve", "spam", "trash", "delete"]),
	})
	.meta({ id: "CommentBulkBody" });

export const commentListQuery = z
	.object({
		status: z.enum(["pending", "approved", "spam", "trash"]).optional(),
		collection: z.string().optional(),
		search: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
		cursor: z.string().max(2048).optional(),
	})
	.meta({ id: "CommentListQuery" });

// ---------------------------------------------------------------------------
// Comments: Response schemas
// ---------------------------------------------------------------------------

const commentStatusValues = z.enum(["pending", "approved", "spam", "trash"]);

/**
 * Public-facing comment (no email/IP).
 *
 * `replies` is recursive in practice (each reply can have replies), but we
 * model it as a single level here to avoid circular type inference issues
 * with tsgo. OpenAPI consumers should treat replies as the same shape.
 */
export const publicCommentSchema: z.ZodObject<{
	id: z.ZodString;
	authorName: z.ZodString;
	isRegisteredUser: z.ZodBoolean;
	body: z.ZodString;
	parentId: z.ZodNullable<z.ZodString>;
	createdAt: z.ZodString;
	replies: z.ZodOptional<z.ZodArray<z.ZodAny>>;
}> = z
	.object({
		id: z.string(),
		authorName: z.string(),
		isRegisteredUser: z.boolean(),
		body: z.string(),
		parentId: z.string().nullable(),
		createdAt: z.string(),
		replies: z.array(z.any()).optional(),
	})
	.meta({ id: "PublicComment" });

/** Admin comment with full details */
export const commentSchema = z
	.object({
		id: z.string(),
		collection: z.string(),
		contentId: z.string(),
		authorName: z.string(),
		authorEmail: z.string(),
		body: z.string(),
		status: commentStatusValues,
		parentId: z.string().nullable(),
		ipHash: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "Comment" });

export const publicCommentListResponseSchema = z
	.object({
		items: z.array(publicCommentSchema),
		nextCursor: z.string().optional(),
		total: z.number().int(),
	})
	.meta({ id: "PublicCommentListResponse" });

export const adminCommentListResponseSchema = z
	.object({
		items: z.array(commentSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "AdminCommentListResponse" });

export const commentCountsResponseSchema = z
	.object({
		pending: z.number().int(),
		approved: z.number().int(),
		spam: z.number().int(),
		trash: z.number().int(),
	})
	.meta({ id: "CommentCountsResponse" });

export const commentBulkResponseSchema = z
	.object({ affected: z.number().int() })
	.meta({ id: "CommentBulkResponse" });
