/**
 * OpenAPI 3.1 document generator.
 *
 * Builds the full OpenAPI spec from Zod schemas. The Zod schemas are the
 * single source of truth -- we never hand-write OpenAPI YAML.
 *
 * Covers all public API domains.
 */

import { z } from "zod";
import { createDocument, type ZodOpenApiPathsObject, type oas31 } from "zod-openapi";

import {
	commentBulkBody,
	commentBulkResponseSchema,
	commentCountsResponseSchema,
	commentListQuery,
	commentSchema,
	commentStatusBody,
	createCommentBody,
	adminCommentListResponseSchema,
	publicCommentListResponseSchema,
} from "../schemas/comments.js";
import { apiErrorSchema, deleteResponseSchema, successEnvelope } from "../schemas/common.js";
import {
	contentCompareResponseSchema,
	contentCreateBody,
	contentItemSchema,
	contentListQuery,
	contentListResponseSchema,
	contentResponseSchema,
	contentScheduleBody,
	contentTermsBody,
	contentTrashQuery,
	contentTranslationsResponseSchema,
	contentUpdateBody,
	trashedContentListResponseSchema,
} from "../schemas/content.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
	mediaConfirmBody,
	mediaConfirmResponseSchema,
	mediaExistingResponseSchema,
	mediaListQuery,
	mediaListResponseSchema,
	mediaResponseSchema,
	mediaUpdateBody,
	mediaUploadUrlBody,
	mediaUploadUrlResponseSchema,
} from "../schemas/media.js";
import {
	createMenuBody,
	createMenuItemBody,
	menuListItemSchema,
	menuItemSchema,
	menuWithItemsSchema,
	reorderMenuItemsBody,
	updateMenuBody,
	updateMenuItemBody,
} from "../schemas/menus.js";
import {
	createRedirectBody,
	notFoundListQuery,
	notFoundPruneBody,
	notFoundListResponseSchema,
	notFoundSummaryResponseSchema,
	redirectListResponseSchema,
	redirectSchema,
	redirectsListQuery,
	updateRedirectBody,
} from "../schemas/redirects.js";
import {
	collectionGetQuery,
	collectionListResponseSchema,
	collectionResponseSchema,
	collectionWithFieldsResponseSchema,
	createCollectionBody,
	createFieldBody,
	fieldListResponseSchema,
	fieldReorderBody,
	fieldResponseSchema,
	orphanedTableListResponseSchema,
	orphanRegisterBody,
	updateCollectionBody,
	updateFieldBody,
} from "../schemas/schema.js";
import {
	searchEnableBody,
	searchQuery,
	searchRebuildBody,
	searchResponseSchema,
	searchSuggestQuery,
} from "../schemas/search.js";
import {
	createSectionBody,
	sectionListResponseSchema,
	sectionSchema,
	sectionsListQuery,
	updateSectionBody,
} from "../schemas/sections.js";
import { settingsUpdateBody, siteSettingsSchema } from "../schemas/settings.js";
import {
	createTermBody,
	taxonomyListResponseSchema,
	termGetResponseSchema,
	termListResponseSchema,
	termResponseSchema,
	updateTermBody,
} from "../schemas/taxonomies.js";
import {
	allowedDomainCreateBody,
	allowedDomainUpdateBody,
	userDetailSchema,
	userListResponseSchema,
	userSchema,
	userUpdateBody,
	usersListQuery,
} from "../schemas/users.js";
import {
	createWidgetAreaBody,
	createWidgetBody,
	reorderWidgetsBody,
	updateWidgetBody,
	widgetAreaSchema,
	widgetAreaWithWidgetsSchema,
	widgetSchema,
} from "../schemas/widgets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSON_CONTENT = "application/json";

/** Standard error responses shared across all authenticated endpoints */
function standardErrors(
	...codes: number[]
): Record<
	string,
	{ description: string; content: Record<string, { schema: typeof apiErrorSchema }> }
> {
	const responses: Record<
		string,
		{ description: string; content: Record<string, { schema: typeof apiErrorSchema }> }
	> = {};
	const errorMap: Record<number, string> = {
		400: "Bad Request",
		401: "Not authenticated",
		403: "Forbidden",
		404: "Not Found",
		409: "Conflict",
		500: "Internal Server Error",
	};
	for (const code of codes) {
		responses[String(code)] = {
			description: errorMap[code] ?? `Error ${code}`,
			content: { [JSON_CONTENT]: { schema: apiErrorSchema } },
		};
	}
	return responses;
}

/** Common auth error responses (401 + 403) */
const authErrors = standardErrors(401, 403);

// ---------------------------------------------------------------------------
// Content routes
// ---------------------------------------------------------------------------

const contentPaths = {
	"/_emdash/api/content/{collection}": {
		get: {
			operationId: "listContent",
			summary: "List content items",
			description: "Returns a paginated list of content items in the specified collection.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug", example: "posts" }),
				}),
				query: contentListQuery,
			},
			responses: {
				"200": {
					description: "Content list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentListResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createContent",
			summary: "Create a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
				}),
			},
			requestBody: {
				content: { [JSON_CONTENT]: { schema: contentCreateBody } },
			},
			responses: {
				"201": {
					description: "Created content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}": {
		get: {
			operationId: "getContent",
			summary: "Get a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
				query: z.object({
					locale: z.string().optional().meta({ description: "Locale filter" }),
				}),
			},
			responses: {
				"200": {
					description: "Content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateContent",
			summary: "Update a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			requestBody: {
				content: { [JSON_CONTENT]: { schema: contentUpdateBody } },
			},
			responses: {
				"200": {
					description: "Updated content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 409, 500),
			},
		},
		delete: {
			operationId: "deleteContent",
			summary: "Delete a content item (soft delete)",
			description:
				"Moves the content item to trash. Use the permanent delete endpoint to remove permanently.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(deleteResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/publish": {
		post: {
			operationId: "publishContent",
			summary: "Publish a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Published content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/unpublish": {
		post: {
			operationId: "unpublishContent",
			summary: "Unpublish a content item",
			description: "Reverts content to draft status.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Unpublished content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/schedule": {
		post: {
			operationId: "scheduleContent",
			summary: "Schedule content for future publishing",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			requestBody: {
				content: { [JSON_CONTENT]: { schema: contentScheduleBody } },
			},
			responses: {
				"200": {
					description: "Scheduled content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		delete: {
			operationId: "unscheduleContent",
			summary: "Cancel scheduled publishing",
			description: "Reverts a scheduled item to draft status.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Unscheduled content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/duplicate": {
		post: {
			operationId: "duplicateContent",
			summary: "Duplicate a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"201": {
					description: "Duplicated content item",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ item: contentItemSchema })),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/restore": {
		post: {
			operationId: "restoreContent",
			summary: "Restore a content item from trash",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID" }),
				}),
			},
			responses: {
				"200": {
					description: "Restored",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ restored: z.literal(true) })),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/permanent": {
		delete: {
			operationId: "permanentDeleteContent",
			summary: "Permanently delete a content item",
			description: "Permanently removes a trashed content item. This cannot be undone.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID" }),
				}),
			},
			responses: {
				"200": {
					description: "Permanently deleted",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(deleteResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/compare": {
		get: {
			operationId: "compareContent",
			summary: "Compare live and draft revisions",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Comparison result",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentCompareResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/discard-draft": {
		post: {
			operationId: "discardDraft",
			summary: "Discard draft changes",
			description: "Reverts the content item to its live (published) version.",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Content item reverted to live version",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/translations": {
		get: {
			operationId: "getContentTranslations",
			summary: "Get translations for a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Translation group members",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(contentTranslationsResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/{id}/terms": {
		put: {
			operationId: "setContentTerms",
			summary: "Set taxonomy terms on a content item",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					id: z.string().meta({ description: "Content ID or slug" }),
				}),
			},
			requestBody: {
				content: { [JSON_CONTENT]: { schema: contentTermsBody } },
			},
			responses: {
				"200": {
					description: "Terms updated",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ termIds: z.array(z.string()) })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},

	"/_emdash/api/content/{collection}/trash": {
		get: {
			operationId: "listTrashedContent",
			summary: "List trashed content items",
			tags: ["Content"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
				}),
				query: contentTrashQuery,
			},
			responses: {
				"200": {
					description: "Trashed content list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(trashedContentListResponseSchema),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Media routes
// ---------------------------------------------------------------------------

function buildMediaPaths(maxUploadSize: number) {
	return {
		"/_emdash/api/media": {
			get: {
				operationId: "listMedia",
				summary: "List media items",
				tags: ["Media"],
				requestParams: { query: mediaListQuery },
				responses: {
					"200": {
						description: "Media list",
						content: { [JSON_CONTENT]: { schema: successEnvelope(mediaListResponseSchema) } },
					},
					...authErrors,
					...standardErrors(500),
				},
			},
		},
		"/_emdash/api/media/{id}": {
			get: {
				operationId: "getMedia",
				summary: "Get a media item",
				tags: ["Media"],
				requestParams: {
					path: z.object({ id: z.string().meta({ description: "Media ID" }) }),
				},
				responses: {
					"200": {
						description: "Media item",
						content: { [JSON_CONTENT]: { schema: successEnvelope(mediaResponseSchema) } },
					},
					...authErrors,
					...standardErrors(404, 500),
				},
			},
			put: {
				operationId: "updateMedia",
				summary: "Update media metadata",
				tags: ["Media"],
				requestParams: {
					path: z.object({ id: z.string().meta({ description: "Media ID" }) }),
				},
				requestBody: { content: { [JSON_CONTENT]: { schema: mediaUpdateBody } } },
				responses: {
					"200": {
						description: "Updated media item",
						content: { [JSON_CONTENT]: { schema: successEnvelope(mediaResponseSchema) } },
					},
					...authErrors,
					...standardErrors(400, 404, 500),
				},
			},
			delete: {
				operationId: "deleteMedia",
				summary: "Delete a media item",
				tags: ["Media"],
				requestParams: {
					path: z.object({ id: z.string().meta({ description: "Media ID" }) }),
				},
				responses: {
					"200": {
						description: "Deleted",
						content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
					},
					...authErrors,
					...standardErrors(404, 500),
				},
			},
		},
		"/_emdash/api/media/upload-url": {
			post: {
				operationId: "getMediaUploadUrl",
				summary: "Get a signed URL for direct upload",
				description:
					"Returns a signed URL for direct-to-storage upload. Creates a pending media record.",
				tags: ["Media"],
				requestBody: { content: { [JSON_CONTENT]: { schema: mediaUploadUrlBody(maxUploadSize) } } },
				responses: {
					"200": {
						description: "Upload URL or existing media (deduplication)",
						content: {
							[JSON_CONTENT]: {
								schema: successEnvelope(
									z.union([mediaUploadUrlResponseSchema, mediaExistingResponseSchema]),
								),
							},
						},
					},
					...authErrors,
					...standardErrors(400, 500),
				},
			},
		},
		"/_emdash/api/media/{id}/confirm": {
			post: {
				operationId: "confirmMediaUpload",
				summary: "Confirm a media upload",
				description: "Marks a pending media record as ready after the file has been uploaded.",
				tags: ["Media"],
				requestParams: {
					path: z.object({ id: z.string().meta({ description: "Media ID" }) }),
				},
				requestBody: { content: { [JSON_CONTENT]: { schema: mediaConfirmBody } } },
				responses: {
					"200": {
						description: "Confirmed media item with URL",
						content: {
							[JSON_CONTENT]: { schema: successEnvelope(mediaConfirmResponseSchema) },
						},
					},
					...authErrors,
					...standardErrors(400, 404, 500),
				},
			},
		},
	} as const;
}

// ---------------------------------------------------------------------------
// Schema routes
// ---------------------------------------------------------------------------

const schemaPaths = {
	"/_emdash/api/schema/collections": {
		get: {
			operationId: "listCollections",
			summary: "List all collections",
			tags: ["Schema"],
			responses: {
				"200": {
					description: "Collection list",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(collectionListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createCollection",
			summary: "Create a collection",
			tags: ["Schema"],
			requestBody: { content: { [JSON_CONTENT]: { schema: createCollectionBody } } },
			responses: {
				"201": {
					description: "Created collection",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(collectionResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/schema/collections/{slug}": {
		get: {
			operationId: "getCollection",
			summary: "Get a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
				query: collectionGetQuery,
			},
			responses: {
				"200": {
					description: "Collection (optionally with fields)",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.union([
									collectionResponseSchema.shape.item,
									collectionWithFieldsResponseSchema.shape.item,
								]),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateCollection",
			summary: "Update a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateCollectionBody } } },
			responses: {
				"200": {
					description: "Updated collection",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(collectionResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		delete: {
			operationId: "deleteCollection",
			summary: "Delete a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/schema/collections/{slug}/fields": {
		get: {
			operationId: "listFields",
			summary: "List fields for a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
			},
			responses: {
				"200": {
					description: "Field list",
					content: { [JSON_CONTENT]: { schema: successEnvelope(fieldListResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		post: {
			operationId: "createField",
			summary: "Create a field",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: createFieldBody } } },
			responses: {
				"201": {
					description: "Created field",
					content: { [JSON_CONTENT]: { schema: successEnvelope(fieldResponseSchema) } },
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/schema/collections/{slug}/fields/{fieldSlug}": {
		get: {
			operationId: "getField",
			summary: "Get a field",
			tags: ["Schema"],
			requestParams: {
				path: z.object({
					slug: z.string().meta({ description: "Collection slug" }),
					fieldSlug: z.string().meta({ description: "Field slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Field",
					content: { [JSON_CONTENT]: { schema: successEnvelope(fieldResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateField",
			summary: "Update a field",
			tags: ["Schema"],
			requestParams: {
				path: z.object({
					slug: z.string().meta({ description: "Collection slug" }),
					fieldSlug: z.string().meta({ description: "Field slug" }),
				}),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateFieldBody } } },
			responses: {
				"200": {
					description: "Updated field",
					content: { [JSON_CONTENT]: { schema: successEnvelope(fieldResponseSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		delete: {
			operationId: "deleteField",
			summary: "Delete a field",
			tags: ["Schema"],
			requestParams: {
				path: z.object({
					slug: z.string().meta({ description: "Collection slug" }),
					fieldSlug: z.string().meta({ description: "Field slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/schema/collections/{slug}/fields/reorder": {
		post: {
			operationId: "reorderFields",
			summary: "Reorder fields in a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Collection slug" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: fieldReorderBody } } },
			responses: {
				"200": {
					description: "Reordered",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ success: z.literal(true) })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
	"/_emdash/api/schema/orphans": {
		get: {
			operationId: "listOrphanedTables",
			summary: "List orphaned content tables",
			description: "Finds ec_* tables without matching collection definitions.",
			tags: ["Schema"],
			responses: {
				"200": {
					description: "Orphaned tables",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(orphanedTableListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/schema/orphans/{slug}": {
		post: {
			operationId: "registerOrphanedTable",
			summary: "Register an orphaned table as a collection",
			tags: ["Schema"],
			requestParams: {
				path: z.object({
					slug: z.string().meta({ description: "Table slug (without ec_ prefix)" }),
				}),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: orphanRegisterBody } } },
			responses: {
				"201": {
					description: "Registered collection",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(collectionResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Comments routes
// ---------------------------------------------------------------------------

const commentsPaths = {
	"/_emdash/api/comments/{collection}/{contentId}": {
		get: {
			operationId: "listPublicComments",
			summary: "List approved comments for content",
			description: "Public endpoint. Returns approved comments with optional threading.",
			tags: ["Comments"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					contentId: z.string().meta({ description: "Content ID" }),
				}),
				query: z.object({
					limit: z.coerce.number().int().min(1).max(100).optional(),
					cursor: z.string().optional(),
					threaded: z
						.enum(["true", "false"])
						.transform((v) => v === "true")
						.optional(),
				}),
			},
			responses: {
				"200": {
					description: "Comment list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(publicCommentListResponseSchema),
						},
					},
				},
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createComment",
			summary: "Submit a new comment",
			description: "Public endpoint. Comment enters moderation queue.",
			tags: ["Comments"],
			requestParams: {
				path: z.object({
					collection: z.string().meta({ description: "Collection slug" }),
					contentId: z.string().meta({ description: "Content ID" }),
				}),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: createCommentBody } } },
			responses: {
				"201": {
					description: "Comment created (pending moderation)",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ id: z.string(), status: z.string() })),
						},
					},
				},
				...standardErrors(400, 429, 500),
			},
		},
	},
	"/_emdash/api/admin/comments": {
		get: {
			operationId: "listAdminComments",
			summary: "List comments for moderation",
			tags: ["Comments"],
			requestParams: { query: commentListQuery },
			responses: {
				"200": {
					description: "Comment moderation inbox",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(adminCommentListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/admin/comments/counts": {
		get: {
			operationId: "getCommentCounts",
			summary: "Get comment status counts",
			tags: ["Comments"],
			responses: {
				"200": {
					description: "Counts by status",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(commentCountsResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/admin/comments/bulk": {
		post: {
			operationId: "bulkCommentAction",
			summary: "Bulk approve, spam, trash, or delete comments",
			tags: ["Comments"],
			requestBody: { content: { [JSON_CONTENT]: { schema: commentBulkBody } } },
			responses: {
				"200": {
					description: "Bulk action result",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(commentBulkResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},
	"/_emdash/api/admin/comments/{id}": {
		get: {
			operationId: "getComment",
			summary: "Get a single comment",
			tags: ["Comments"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Comment ID" }) }),
			},
			responses: {
				"200": {
					description: "Comment",
					content: { [JSON_CONTENT]: { schema: successEnvelope(commentSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		delete: {
			operationId: "deleteComment",
			summary: "Permanently delete a comment",
			tags: ["Comments"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Comment ID" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/admin/comments/{id}/status": {
		put: {
			operationId: "updateCommentStatus",
			summary: "Change comment status",
			tags: ["Comments"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Comment ID" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: commentStatusBody } } },
			responses: {
				"200": {
					description: "Updated comment",
					content: { [JSON_CONTENT]: { schema: successEnvelope(commentSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Taxonomy routes
// ---------------------------------------------------------------------------

const taxonomyPaths = {
	"/_emdash/api/taxonomies": {
		get: {
			operationId: "listTaxonomies",
			summary: "List all taxonomy definitions",
			tags: ["Taxonomies"],
			responses: {
				"200": {
					description: "Taxonomy list",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(taxonomyListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/taxonomies/{name}/terms": {
		get: {
			operationId: "listTerms",
			summary: "List terms for a taxonomy",
			description: "Returns a tree for hierarchical taxonomies, flat list otherwise.",
			tags: ["Taxonomies"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Taxonomy name" }) }),
			},
			responses: {
				"200": {
					description: "Term list",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(termListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		post: {
			operationId: "createTerm",
			summary: "Create a term",
			tags: ["Taxonomies"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Taxonomy name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: createTermBody } } },
			responses: {
				"201": {
					description: "Created term",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(termResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/taxonomies/{name}/terms/{slug}": {
		get: {
			operationId: "getTerm",
			summary: "Get a term by slug",
			tags: ["Taxonomies"],
			requestParams: {
				path: z.object({
					name: z.string().meta({ description: "Taxonomy name" }),
					slug: z.string().meta({ description: "Term slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Term with children and count",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(termGetResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateTerm",
			summary: "Update a term",
			tags: ["Taxonomies"],
			requestParams: {
				path: z.object({
					name: z.string().meta({ description: "Taxonomy name" }),
					slug: z.string().meta({ description: "Term slug" }),
				}),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateTermBody } } },
			responses: {
				"200": {
					description: "Updated term",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(termResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 404, 409, 500),
			},
		},
		delete: {
			operationId: "deleteTerm",
			summary: "Delete a term",
			tags: ["Taxonomies"],
			requestParams: {
				path: z.object({
					name: z.string().meta({ description: "Taxonomy name" }),
					slug: z.string().meta({ description: "Term slug" }),
				}),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Menu routes
// ---------------------------------------------------------------------------

const menuPaths = {
	"/_emdash/api/menus": {
		get: {
			operationId: "listMenus",
			summary: "List all menus with item counts",
			tags: ["Menus"],
			responses: {
				"200": {
					description: "Menu list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.array(menuListItemSchema)),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createMenu",
			summary: "Create a menu",
			tags: ["Menus"],
			requestBody: { content: { [JSON_CONTENT]: { schema: createMenuBody } } },
			responses: {
				"201": {
					description: "Created menu",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(menuWithItemsSchema) },
					},
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/menus/{name}": {
		get: {
			operationId: "getMenu",
			summary: "Get a menu with all items",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
			},
			responses: {
				"200": {
					description: "Menu with items",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(menuWithItemsSchema) },
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateMenu",
			summary: "Update a menu",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateMenuBody } } },
			responses: {
				"200": {
					description: "Updated menu",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(menuWithItemsSchema) },
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		delete: {
			operationId: "deleteMenu",
			summary: "Delete a menu and its items",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/menus/{name}/items": {
		post: {
			operationId: "createMenuItem",
			summary: "Add an item to a menu",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: createMenuItemBody } } },
			responses: {
				"201": {
					description: "Created menu item",
					content: { [JSON_CONTENT]: { schema: successEnvelope(menuItemSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		put: {
			operationId: "updateMenuItem",
			summary: "Update a menu item",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
				query: z.object({ id: z.string().meta({ description: "Menu item ID" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateMenuItemBody } } },
			responses: {
				"200": {
					description: "Updated menu item",
					content: { [JSON_CONTENT]: { schema: successEnvelope(menuItemSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		delete: {
			operationId: "deleteMenuItem",
			summary: "Delete a menu item",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
				query: z.object({ id: z.string().meta({ description: "Menu item ID" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/menus/{name}/reorder": {
		post: {
			operationId: "reorderMenuItems",
			summary: "Batch reorder menu items",
			tags: ["Menus"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Menu name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: reorderMenuItemsBody } } },
			responses: {
				"200": {
					description: "Reordered items",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.array(menuItemSchema)),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Section routes
// ---------------------------------------------------------------------------

const sectionPaths = {
	"/_emdash/api/sections": {
		get: {
			operationId: "listSections",
			summary: "List sections",
			tags: ["Sections"],
			requestParams: { query: sectionsListQuery },
			responses: {
				"200": {
					description: "Section list",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(sectionListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createSection",
			summary: "Create a section",
			tags: ["Sections"],
			requestBody: { content: { [JSON_CONTENT]: { schema: createSectionBody } } },
			responses: {
				"201": {
					description: "Created section",
					content: { [JSON_CONTENT]: { schema: successEnvelope(sectionSchema) } },
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/sections/{slug}": {
		get: {
			operationId: "getSection",
			summary: "Get a section by slug",
			tags: ["Sections"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Section slug" }) }),
			},
			responses: {
				"200": {
					description: "Section",
					content: { [JSON_CONTENT]: { schema: successEnvelope(sectionSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateSection",
			summary: "Update a section",
			tags: ["Sections"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Section slug" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateSectionBody } } },
			responses: {
				"200": {
					description: "Updated section",
					content: { [JSON_CONTENT]: { schema: successEnvelope(sectionSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 409, 500),
			},
		},
		delete: {
			operationId: "deleteSection",
			summary: "Delete a section",
			tags: ["Sections"],
			requestParams: {
				path: z.object({ slug: z.string().meta({ description: "Section slug" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(403, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Widget routes
// ---------------------------------------------------------------------------

const widgetPaths = {
	"/_emdash/api/widget-areas": {
		get: {
			operationId: "listWidgetAreas",
			summary: "List all widget areas",
			tags: ["Widgets"],
			responses: {
				"200": {
					description: "Widget area list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ items: z.array(widgetAreaSchema) })),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createWidgetArea",
			summary: "Create a widget area",
			tags: ["Widgets"],
			requestBody: { content: { [JSON_CONTENT]: { schema: createWidgetAreaBody } } },
			responses: {
				"201": {
					description: "Created widget area",
					content: { [JSON_CONTENT]: { schema: successEnvelope(widgetAreaSchema) } },
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/widget-areas/{name}": {
		get: {
			operationId: "getWidgetArea",
			summary: "Get a widget area with widgets",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Widget area name" }) }),
			},
			responses: {
				"200": {
					description: "Widget area with widgets",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(widgetAreaWithWidgetsSchema) },
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		delete: {
			operationId: "deleteWidgetArea",
			summary: "Delete a widget area and its widgets",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Widget area name" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/widget-areas/{name}/widgets": {
		post: {
			operationId: "createWidget",
			summary: "Add a widget to an area",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Widget area name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: createWidgetBody } } },
			responses: {
				"201": {
					description: "Created widget",
					content: { [JSON_CONTENT]: { schema: successEnvelope(widgetSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
	"/_emdash/api/widget-areas/{name}/widgets/{id}": {
		put: {
			operationId: "updateWidget",
			summary: "Update a widget",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({
					name: z.string().meta({ description: "Widget area name" }),
					id: z.string().meta({ description: "Widget ID" }),
				}),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateWidgetBody } } },
			responses: {
				"200": {
					description: "Updated widget",
					content: { [JSON_CONTENT]: { schema: successEnvelope(widgetSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
		delete: {
			operationId: "deleteWidget",
			summary: "Delete a widget",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({
					name: z.string().meta({ description: "Widget area name" }),
					id: z.string().meta({ description: "Widget ID" }),
				}),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/widget-areas/{name}/reorder": {
		post: {
			operationId: "reorderWidgets",
			summary: "Reorder widgets in an area",
			tags: ["Widgets"],
			requestParams: {
				path: z.object({ name: z.string().meta({ description: "Widget area name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: reorderWidgetsBody } } },
			responses: {
				"200": {
					description: "Reordered",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ success: z.literal(true) })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Settings routes
// ---------------------------------------------------------------------------

const settingsPaths = {
	"/_emdash/api/settings": {
		get: {
			operationId: "getSettings",
			summary: "Get site settings",
			tags: ["Settings"],
			responses: {
				"200": {
					description: "Site settings",
					content: { [JSON_CONTENT]: { schema: successEnvelope(siteSettingsSchema) } },
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		put: {
			operationId: "updateSettings",
			summary: "Update site settings",
			tags: ["Settings"],
			requestBody: { content: { [JSON_CONTENT]: { schema: settingsUpdateBody } } },
			responses: {
				"200": {
					description: "Updated settings",
					content: { [JSON_CONTENT]: { schema: successEnvelope(siteSettingsSchema) } },
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Search routes
// ---------------------------------------------------------------------------

const searchPaths = {
	"/_emdash/api/search": {
		get: {
			operationId: "search",
			summary: "Full-text search across collections",
			tags: ["Search"],
			requestParams: { query: searchQuery },
			responses: {
				"200": {
					description: "Search results",
					content: { [JSON_CONTENT]: { schema: successEnvelope(searchResponseSchema) } },
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/search/suggest": {
		get: {
			operationId: "searchSuggest",
			summary: "Autocomplete search suggestions",
			tags: ["Search"],
			requestParams: { query: searchSuggestQuery },
			responses: {
				"200": {
					description: "Search suggestions",
					content: { [JSON_CONTENT]: { schema: successEnvelope(searchResponseSchema) } },
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/search/rebuild": {
		post: {
			operationId: "rebuildSearchIndex",
			summary: "Rebuild the search index for a collection",
			tags: ["Search"],
			requestBody: { content: { [JSON_CONTENT]: { schema: searchRebuildBody } } },
			responses: {
				"200": {
					description: "Rebuild started",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									collection: z.string(),
									indexed: z.number().int(),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},
	"/_emdash/api/search/enable": {
		post: {
			operationId: "enableSearch",
			summary: "Enable or disable search for a collection",
			tags: ["Search"],
			requestBody: { content: { [JSON_CONTENT]: { schema: searchEnableBody } } },
			responses: {
				"200": {
					description: "Search config updated",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									collection: z.string(),
									enabled: z.boolean(),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},
	"/_emdash/api/search/stats": {
		get: {
			operationId: "getSearchStats",
			summary: "Get search index statistics",
			tags: ["Search"],
			responses: {
				"200": {
					description: "Search stats per collection",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									collections: z.array(
										z.object({
											collection: z.string(),
											enabled: z.boolean(),
											indexed: z.number().int(),
										}),
									),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Redirect routes
// ---------------------------------------------------------------------------

const redirectPaths = {
	"/_emdash/api/redirects": {
		get: {
			operationId: "listRedirects",
			summary: "List redirects",
			tags: ["Redirects"],
			requestParams: { query: redirectsListQuery },
			responses: {
				"200": {
					description: "Redirect list",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(redirectListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createRedirect",
			summary: "Create a redirect rule",
			tags: ["Redirects"],
			requestBody: { content: { [JSON_CONTENT]: { schema: createRedirectBody } } },
			responses: {
				"201": {
					description: "Created redirect",
					content: { [JSON_CONTENT]: { schema: successEnvelope(redirectSchema) } },
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/redirects/{id}": {
		get: {
			operationId: "getRedirect",
			summary: "Get a redirect",
			tags: ["Redirects"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Redirect ID" }) }),
			},
			responses: {
				"200": {
					description: "Redirect",
					content: { [JSON_CONTENT]: { schema: successEnvelope(redirectSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateRedirect",
			summary: "Update a redirect",
			tags: ["Redirects"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Redirect ID" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: updateRedirectBody } } },
			responses: {
				"200": {
					description: "Updated redirect",
					content: { [JSON_CONTENT]: { schema: successEnvelope(redirectSchema) } },
				},
				...authErrors,
				...standardErrors(400, 404, 409, 500),
			},
		},
		delete: {
			operationId: "deleteRedirect",
			summary: "Delete a redirect",
			tags: ["Redirects"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "Redirect ID" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/redirects/404s": {
		get: {
			operationId: "listNotFoundEntries",
			summary: "List 404 log entries",
			tags: ["Redirects"],
			requestParams: { query: notFoundListQuery },
			responses: {
				"200": {
					description: "404 log entries",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(notFoundListResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		delete: {
			operationId: "clearNotFoundLog",
			summary: "Clear all 404 log entries",
			tags: ["Redirects"],
			responses: {
				"200": {
					description: "Cleared",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ deleted: z.number().int() })),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "pruneNotFoundLog",
			summary: "Prune old 404 log entries",
			tags: ["Redirects"],
			requestBody: { content: { [JSON_CONTENT]: { schema: notFoundPruneBody } } },
			responses: {
				"200": {
					description: "Pruned",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ deleted: z.number().int() })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 500),
			},
		},
	},
	"/_emdash/api/redirects/404s/summary": {
		get: {
			operationId: "getNotFoundSummary",
			summary: "Get 404 summary grouped by path",
			tags: ["Redirects"],
			responses: {
				"200": {
					description: "404 summary",
					content: {
						[JSON_CONTENT]: { schema: successEnvelope(notFoundSummaryResponseSchema) },
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// User management routes
// ---------------------------------------------------------------------------

const userPaths = {
	"/_emdash/api/admin/users": {
		get: {
			operationId: "listUsers",
			summary: "List users",
			tags: ["Users"],
			requestParams: { query: usersListQuery },
			responses: {
				"200": {
					description: "User list",
					content: { [JSON_CONTENT]: { schema: successEnvelope(userListResponseSchema) } },
				},
				...authErrors,
				...standardErrors(500),
			},
		},
	},
	"/_emdash/api/admin/users/{id}": {
		get: {
			operationId: "getUser",
			summary: "Get user details",
			tags: ["Users"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "User ID" }) }),
			},
			responses: {
				"200": {
					description: "User detail",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ item: userDetailSchema })),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		put: {
			operationId: "updateUser",
			summary: "Update a user",
			tags: ["Users"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "User ID" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: userUpdateBody } } },
			responses: {
				"200": {
					description: "Updated user",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ item: userSchema })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 409, 500),
			},
		},
	},
	"/_emdash/api/admin/users/{id}/disable": {
		post: {
			operationId: "disableUser",
			summary: "Disable a user account",
			tags: ["Users"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "User ID" }) }),
			},
			responses: {
				"200": {
					description: "User disabled",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ item: userSchema })),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 404, 500),
			},
		},
	},
	"/_emdash/api/admin/users/{id}/enable": {
		post: {
			operationId: "enableUser",
			summary: "Enable a user account",
			tags: ["Users"],
			requestParams: {
				path: z.object({ id: z.string().meta({ description: "User ID" }) }),
			},
			responses: {
				"200": {
					description: "User enabled",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(z.object({ item: userSchema })),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
	"/_emdash/api/admin/allowed-domains": {
		get: {
			operationId: "listAllowedDomains",
			summary: "List allowed email domains",
			tags: ["Users"],
			responses: {
				"200": {
					description: "Allowed domains list",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									items: z.array(
										z.object({
											domain: z.string(),
											defaultRole: z.number().int(),
											enabled: z.boolean(),
											createdAt: z.string(),
										}),
									),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(500),
			},
		},
		post: {
			operationId: "createAllowedDomain",
			summary: "Add an allowed email domain",
			tags: ["Users"],
			requestBody: { content: { [JSON_CONTENT]: { schema: allowedDomainCreateBody } } },
			responses: {
				"201": {
					description: "Created",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									domain: z.string(),
									defaultRole: z.number().int(),
									enabled: z.boolean(),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(400, 409, 500),
			},
		},
	},
	"/_emdash/api/admin/allowed-domains/{domain}": {
		put: {
			operationId: "updateAllowedDomain",
			summary: "Update an allowed domain",
			tags: ["Users"],
			requestParams: {
				path: z.object({ domain: z.string().meta({ description: "Domain name" }) }),
			},
			requestBody: { content: { [JSON_CONTENT]: { schema: allowedDomainUpdateBody } } },
			responses: {
				"200": {
					description: "Updated",
					content: {
						[JSON_CONTENT]: {
							schema: successEnvelope(
								z.object({
									domain: z.string(),
									defaultRole: z.number().int(),
									enabled: z.boolean(),
								}),
							),
						},
					},
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
		delete: {
			operationId: "deleteAllowedDomain",
			summary: "Remove an allowed domain",
			tags: ["Users"],
			requestParams: {
				path: z.object({ domain: z.string().meta({ description: "Domain name" }) }),
			},
			responses: {
				"200": {
					description: "Deleted",
					content: { [JSON_CONTENT]: { schema: successEnvelope(deleteResponseSchema) } },
				},
				...authErrors,
				...standardErrors(404, 500),
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Merge all paths
// ---------------------------------------------------------------------------

function buildAllPaths(maxUploadSize: number) {
	return {
		...contentPaths,
		...buildMediaPaths(maxUploadSize),
		...schemaPaths,
		...commentsPaths,
		...taxonomyPaths,
		...menuPaths,
		...sectionPaths,
		...widgetPaths,
		...settingsPaths,
		...searchPaths,
		...redirectPaths,
		...userPaths,
	} as const;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Generate the OpenAPI 3.1 document for the EmDash CMS API.
 *
 * Covers: Content, Media, Schema, Comments, Taxonomies, Menus,
 * Sections, Widgets, Settings, Search, Redirects, Users.
 */
export function generateOpenApiDocument(
	options: { maxUploadSize?: number } = {},
): oas31.OpenAPIObject {
	const maxUploadSize = options.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE;
	return createDocument({
		openapi: "3.1.0",
		info: {
			title: "EmDash CMS API",
			version: "0.1.0",
			description:
				"REST API for the EmDash CMS. All endpoints require authentication and return responses wrapped in a `{ data }` envelope.",
		},
		servers: [
			{
				url: "{baseUrl}",
				description: "CMS instance",
				// Note: `description` on server variables is valid per OAS 3.1 spec but
				// swagger-parser rejects it as an unevaluated property. Omitted as a workaround.
				variables: {
					baseUrl: {
						default: "http://localhost:4321",
					},
				},
			},
		],
		tags: [
			{
				name: "Content",
				description: "CRUD operations for content items across collections",
			},
			{
				name: "Media",
				description: "Media library — upload, manage, and serve files",
			},
			{
				name: "Schema",
				description: "Collection and field management",
			},
			{
				name: "Comments",
				description: "Public comments and admin moderation",
			},
			{
				name: "Taxonomies",
				description: "Taxonomy definitions and terms",
			},
			{
				name: "Menus",
				description: "Navigation menu management",
			},
			{
				name: "Sections",
				description: "Reusable content sections",
			},
			{
				name: "Widgets",
				description: "Widget areas and widget management",
			},
			{
				name: "Settings",
				description: "Site-wide settings",
			},
			{
				name: "Search",
				description: "Full-text search and index management",
			},
			{
				name: "Redirects",
				description: "Redirect rules and 404 logging",
			},
			{
				name: "Users",
				description: "User management and access control",
			},
		],
		components: {
			securitySchemes: {
				session: {
					type: "apiKey",
					in: "cookie",
					name: "emdash_session",
					description: "Session cookie set by the auth endpoints",
				},
				bearer: {
					type: "http",
					scheme: "bearer",
					description: "OAuth2 or API token",
				},
			},
		},
		security: [{ session: [] }, { bearer: [] }],
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- readonly const paths are compatible at runtime
		paths: buildAllPaths(maxUploadSize) as unknown as ZodOpenApiPathsObject,
	});
}
