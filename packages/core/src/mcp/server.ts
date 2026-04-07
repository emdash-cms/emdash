/**
 * EmDash MCP Server
 *
 * Exposes content, schema, media, search, taxonomy, and menu operations
 * as MCP tools over the Streamable HTTP transport.
 *
 * Tools use the EmDashHandlers interface (same as locals.emdash) so
 * they work with the pre-bound handlers that the middleware provides.
 * The handlers instance is passed per-request via authInfo on the transport.
 */

import type { Permission, RoleLevel } from "@emdash-cms/auth";
import { canActOnOwn, Role } from "@emdash-cms/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { EmDashHandlers } from "../astro/types.js";
import { hasScope } from "../auth/api-tokens.js";

const COLLECTION_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HandlerResult = { success: boolean; data?: unknown; error?: unknown };

/**
 * Unwrap an ApiResult<T> into MCP tool result format.
 * On success, returns the data as pretty-printed JSON text content.
 * On failure, returns the error message with isError flag.
 */
function unwrap(result: HandlerResult): {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
} {
	if (result.success && result.data !== undefined) {
		return {
			content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
		};
	}
	const errMsg =
		result.error && typeof result.error === "object" && "message" in result.error
			? String((result.error as Record<string, unknown>).message)
			: "Unknown error";
	return { content: [{ type: "text", text: errMsg }], isError: true };
}

/**
 * Return a JSON text block.
 */
function jsonResult(data: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}

/**
 * Return an error text block.
 */
function errorResult(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	const msg = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// Context extraction
//
// The route handler passes emdash + userId in authInfo.extra.
// ---------------------------------------------------------------------------

interface EmDashExtra {
	emdash: EmDashHandlers;
	userId: string;
	/** The authenticated user's RBAC role level. */
	userRole: RoleLevel;
	/** Token scopes — undefined for session auth (all access allowed). */
	tokenScopes?: string[];
}

function getExtra(extra: { authInfo?: { extra?: Record<string, unknown> } }): EmDashExtra {
	const payload = extra.authInfo?.extra as EmDashExtra | undefined;
	if (!payload?.emdash) {
		throw new Error("EmDash not available — server misconfigured");
	}
	return payload;
}

function getEmDash(extra: { authInfo?: { extra?: Record<string, unknown> } }): EmDashHandlers {
	return getExtra(extra).emdash;
}

/**
 * Enforce a scope requirement on the current request.
 *
 * When tokenScopes is undefined (session auth), all operations are allowed
 * since session users have full access based on their role. When scopes are
 * present (token auth), the required scope must be included.
 */
function requireScope(
	extra: { authInfo?: { extra?: Record<string, unknown> } },
	scope: string,
): void {
	const payload = getExtra(extra);
	if (payload.tokenScopes && !hasScope(payload.tokenScopes, scope)) {
		throw new McpError(ErrorCode.InvalidRequest, `Insufficient scope: requires ${scope}`);
	}
}

/**
 * Defense-in-depth: enforce a minimum RBAC role on the current request.
 *
 * This is checked in addition to scope requirements. Even if a token has
 * the right scopes (e.g. due to a bug in scope clamping), the user's
 * actual role must still meet the minimum.
 */
function requireRole(
	extra: { authInfo?: { extra?: Record<string, unknown> } },
	minRole: RoleLevel,
): void {
	const payload = getExtra(extra);
	if (payload.userRole < minRole) {
		throw new McpError(ErrorCode.InvalidRequest, "Insufficient permissions for this operation");
	}
}

/**
 * Enforce ownership-based permission checks, mirroring the REST API's
 * requireOwnerPerm() pattern.
 *
 * If the user is the owner, checks ownPermission. Otherwise checks
 * anyPermission (which requires EDITOR+ role).
 */
function requireOwnership(
	extra: { authInfo?: { extra?: Record<string, unknown> } },
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
): void {
	const payload = getExtra(extra);
	const user = { id: payload.userId, role: payload.userRole };
	if (!canActOnOwn(user, ownerId, ownPermission, anyPermission)) {
		throw new McpError(ErrorCode.InvalidRequest, "Insufficient permissions for this operation");
	}
}

/**
 * Extract the author ID from a content handler response.
 *
 * Content handlers return `{ item: { id, authorId, ... }, _rev? }`.
 * This helper navigates that shape safely.
 */
function extractContentAuthorId(data: unknown): string {
	if (!data || typeof data !== "object") {
		throw new McpError(
			ErrorCode.InternalError,
			"Cannot determine content ownership: no data returned",
		);
	}
	const obj = data as Record<string, unknown>;
	const item =
		obj.item && typeof obj.item === "object" ? (obj.item as Record<string, unknown>) : obj;
	const authorId = typeof item?.authorId === "string" ? item.authorId : "";
	if (!authorId) {
		throw new McpError(
			ErrorCode.InternalError,
			"Cannot determine content ownership: content has no authorId",
		);
	}
	return authorId;
}

/**
 * Extract the resolved ID from a content handler response.
 * Handles slug -> ID resolution performed by the handler.
 */
function extractContentId(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const obj = data as Record<string, unknown>;
	const item =
		obj.item && typeof obj.item === "object" ? (obj.item as Record<string, unknown>) : obj;
	return typeof item?.id === "string" ? item.id : undefined;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "emdash", version: "0.1.0" },
		{ capabilities: { logging: {} } },
	);

	// =====================================================================
	// Content tools
	// =====================================================================

	server.registerTool(
		"content_list",
		{
			title: "List Content",
			description:
				"List content items in a collection with optional filtering and pagination. " +
				"Returns items sorted by the specified field. Use the nextCursor value from " +
				"the response to fetch the next page. Status can be 'draft', 'published', " +
				"or 'scheduled'. If no status is given, all non-trashed items are returned.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug (e.g. 'posts', 'pages')"),
				status: z
					.enum(["draft", "published", "scheduled"])
					.optional()
					.describe("Filter by content status"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Max items to return (default 50, max 100)"),
				cursor: z.string().optional().describe("Pagination cursor from a previous response"),
				orderBy: z
					.string()
					.optional()
					.describe("Field to sort by (e.g. 'created_at', 'updated_at')"),
				order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default 'desc')"),
				locale: z
					.string()
					.optional()
					.describe("Filter by locale (e.g. 'en', 'fr'). Only relevant when i18n is enabled."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(
				await ec.handleContentList(args.collection, {
					status: args.status,
					limit: args.limit,
					cursor: args.cursor,
					orderBy: args.orderBy,
					order: args.order,
					locale: args.locale,
				}),
			);
		},
	);

	server.registerTool(
		"content_get",
		{
			title: "Get Content",
			description:
				"Get a single content item by its ID or slug. Returns the full content data " +
				"including all field values, metadata, and a _rev token for optimistic " +
				"concurrency (pass _rev back when updating to detect conflicts).",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug (e.g. 'posts', 'pages')"),
				id: z.string().describe("Content item ID (ULID) or slug"),
				locale: z
					.string()
					.optional()
					.describe(
						"Locale to scope slug lookup (e.g. 'fr'). Only affects slug resolution; IDs are globally unique.",
					),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(await ec.handleContentGet(args.collection, args.id, args.locale));
		},
	);

	server.registerTool(
		"content_create",
		{
			title: "Create Content",
			description:
				"Create a new content item in a collection. The 'data' object should " +
				"contain field values matching the collection's schema (use " +
				"schema_get_collection to check). Rich text fields accept Portable Text " +
				"JSON arrays. A slug is auto-generated if not provided. Items are created " +
				"as 'draft' by default — use content_publish to make them live.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug (e.g. 'posts', 'pages')"),
				data: z
					.record(z.string(), z.unknown())
					.describe("Field values as key-value pairs matching the collection schema"),
				slug: z.string().optional().describe("URL slug (auto-generated from title if omitted)"),
				status: z
					.enum(["draft", "published"])
					.optional()
					.describe("Initial status (default 'draft')"),
				locale: z
					.string()
					.optional()
					.describe("Locale for this content (e.g. 'fr'). Defaults to default locale."),
				translationOf: z
					.string()
					.optional()
					.describe(
						"ID of the content item this is a translation of. Links items in the same translation group.",
					),
			}),
			annotations: { destructiveHint: false },
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.CONTRIBUTOR);
			const { emdash, userId } = getExtra(extra);
			return unwrap(
				await emdash.handleContentCreate(args.collection, {
					data: args.data,
					slug: args.slug,
					status: args.status,
					authorId: userId,
					locale: args.locale,
					translationOf: args.translationOf,
				}),
			);
		},
	);

	server.registerTool(
		"content_update",
		{
			title: "Update Content",
			description:
				"Update an existing content item. Only include fields you want to change " +
				"in the 'data' object — unspecified fields are left unchanged. Pass the " +
				"_rev token from content_get to enable optimistic concurrency checking " +
				"(the update fails if the item was modified since you read it).",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
				data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Field values to update (only include changed fields)"),
				slug: z.string().optional().describe("New URL slug"),
				status: z.enum(["draft", "published"]).optional().describe("New status"),
				_rev: z
					.string()
					.optional()
					.describe("Revision token from content_get for conflict detection"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const { emdash, userId } = getExtra(extra);

			// Fetch item to check ownership
			const existing = await emdash.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:edit_own",
				"content:edit_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(
				await emdash.handleContentUpdate(args.collection, resolvedId, {
					data: args.data,
					slug: args.slug,
					status: args.status,
					authorId: userId,
					_rev: args._rev,
				}),
			);
		},
	);

	server.registerTool(
		"content_delete",
		{
			title: "Delete Content (Trash)",
			description:
				"Soft-delete a content item by moving it to the trash. The item can be " +
				"restored later with content_restore, or permanently deleted with " +
				"content_permanent_delete.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch item to check ownership
			const existing = await ec.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:delete_own",
				"content:delete_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentDelete(args.collection, resolvedId));
		},
	);

	server.registerTool(
		"content_restore",
		{
			title: "Restore Content",
			description: "Restore a soft-deleted content item from the trash back to its previous state.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch trashed item to check ownership
			const existing = await ec.handleContentGetIncludingTrashed(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:edit_own",
				"content:edit_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentRestore(args.collection, resolvedId));
		},
	);

	server.registerTool(
		"content_permanent_delete",
		{
			title: "Permanently Delete Content",
			description:
				"Permanently and irreversibly delete a trashed content item. The item " +
				"must be in the trash first (use content_delete). This cannot be undone.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.ADMIN);
			const ec = getEmDash(extra);
			return unwrap(await ec.handleContentPermanentDelete(args.collection, args.id));
		},
	);

	server.registerTool(
		"content_publish",
		{
			title: "Publish Content",
			description:
				"Publish a content item, making it live on the site. Creates a published " +
				"revision from the current draft. Further edits create a new draft without " +
				"affecting the live version until re-published.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch item to check ownership
			const existing = await ec.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:publish_own",
				"content:publish_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentPublish(args.collection, resolvedId));
		},
	);

	server.registerTool(
		"content_unpublish",
		{
			title: "Unpublish Content",
			description:
				"Unpublish a content item, reverting it to draft status. It will no " +
				"longer be visible on the live site but its content is preserved.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch item to check ownership
			const existing = await ec.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:publish_own",
				"content:publish_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentUnpublish(args.collection, resolvedId));
		},
	);

	server.registerTool(
		"content_schedule",
		{
			title: "Schedule Content",
			description:
				"Schedule a content item for future publication. It will be automatically " +
				"published at the specified date/time. The scheduledAt value must be an " +
				"ISO 8601 datetime string in the future (e.g. '2025-06-01T09:00:00Z').",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
				scheduledAt: z
					.string()
					.describe("ISO 8601 datetime for publication (e.g. '2025-06-01T09:00:00Z')"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch item to check ownership
			const existing = await ec.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:publish_own",
				"content:publish_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentSchedule(args.collection, resolvedId, args.scheduledAt));
		},
	);

	server.registerTool(
		"content_compare",
		{
			title: "Compare Live vs Draft",
			description:
				"Compare the published (live) version of a content item with its current " +
				"draft. Returns both versions and a flag indicating whether there are " +
				"changes. Useful for reviewing unpublished edits before publishing.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(await ec.handleContentCompare(args.collection, args.id));
		},
	);

	server.registerTool(
		"content_discard_draft",
		{
			title: "Discard Draft",
			description:
				"Discard the current draft changes and revert to the last published " +
				"version. Only works on items that have been published at least once.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch item to check ownership
			const existing = await ec.handleContentGet(args.collection, args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:edit_own",
				"content:edit_any",
			);

			const resolvedId = extractContentId(existing.data) ?? args.id;
			return unwrap(await ec.handleContentDiscardDraft(args.collection, resolvedId));
		},
	);

	server.registerTool(
		"content_list_trashed",
		{
			title: "List Trashed Content",
			description:
				"List soft-deleted content items in a collection's trash. These items " +
				"can be restored with content_restore or permanently deleted with " +
				"content_permanent_delete.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				limit: z.number().int().min(1).max(100).optional().describe("Max items (default 50)"),
				cursor: z.string().optional().describe("Pagination cursor"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(
				await ec.handleContentListTrashed(args.collection, {
					limit: args.limit,
					cursor: args.cursor,
				}),
			);
		},
	);

	server.registerTool(
		"content_duplicate",
		{
			title: "Duplicate Content",
			description:
				"Create a copy of an existing content item. The duplicate is created " +
				"as a draft with '(Copy)' appended to the title and an auto-generated slug.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug to duplicate"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.CONTRIBUTOR);
			const ec = getEmDash(extra);
			return unwrap(await ec.handleContentDuplicate(args.collection, args.id));
		},
	);

	server.registerTool(
		"content_translations",
		{
			title: "Get Content Translations",
			description:
				"Get all locale variants of a content item. Returns the translation group " +
				"and a summary of each locale version (id, locale, slug, status). Only " +
				"relevant when i18n is enabled on the site.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(await ec.handleContentTranslations(args.collection, args.id));
		},
	);

	// =====================================================================
	// Schema tools
	// =====================================================================

	server.registerTool(
		"schema_list_collections",
		{
			title: "List Collections",
			description:
				"List all content collections defined in the CMS. Each collection " +
				"represents a content type (e.g. posts, pages, products) with its own " +
				"schema and database table. Returns slug, label, supported features, " +
				"and timestamps.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (_args, extra) => {
			requireScope(extra, "schema:read");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				const items = await registry.listCollections();
				return jsonResult({ items });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"schema_get_collection",
		{
			title: "Get Collection Schema",
			description:
				"Get detailed info about a collection including all field definitions. " +
				"Fields describe the data model: name, type (string, text, number, " +
				"boolean, datetime, portableText, image, reference, json, select, " +
				"multiSelect, slug), constraints, and validation rules. Use this to " +
				"understand what data content_create and content_update expect.",
			inputSchema: z.object({
				slug: z
					.string()
					.describe(
						"Collection slug (e.g. 'posts'). Use schema_list_collections to see available slugs.",
					),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "schema:read");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				const collection = await registry.getCollectionWithFields(args.slug);
				if (!collection) {
					return errorResult(`Collection '${args.slug}' not found`);
				}
				return jsonResult(collection);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"schema_create_collection",
		{
			title: "Create Collection",
			description:
				"Create a new content collection (content type). This creates a database " +
				"table and schema definition. The slug must be lowercase alphanumeric " +
				"with underscores, starting with a letter. Supports: 'drafts' (draft/" +
				"publish workflow), 'revisions' (version history), 'preview' (live " +
				"preview), 'scheduling' (timed publish), 'search' (full-text indexing).",
			inputSchema: z.object({
				slug: z
					.string()
					.regex(COLLECTION_SLUG_PATTERN)
					.describe("Unique identifier (lowercase letters, numbers, underscores)"),
				label: z.string().describe("Display name (plural, e.g. 'Blog Posts')"),
				labelSingular: z.string().optional().describe("Singular display name (e.g. 'Blog Post')"),
				description: z.string().optional().describe("Description of this collection"),
				icon: z.string().optional().describe("Icon name for the admin UI"),
				supports: z
					.array(z.enum(["drafts", "revisions", "preview", "scheduling", "search"]))
					.optional()
					.describe("Features to enable (default: ['drafts', 'revisions'])"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "schema:write");
			requireRole(extra, Role.ADMIN);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				const collection = await registry.createCollection({
					slug: args.slug,
					label: args.label,
					labelSingular: args.labelSingular,
					description: args.description,
					icon: args.icon,
					supports: args.supports,
				});
				ec.invalidateManifest();
				return jsonResult(collection);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"schema_delete_collection",
		{
			title: "Delete Collection",
			description:
				"Delete a collection and its database table. This is irreversible and " +
				"deletes all content in the collection. Use with extreme caution.",
			inputSchema: z.object({
				slug: z.string().describe("Collection slug to delete"),
				force: z
					.boolean()
					.optional()
					.describe("Force deletion even if the collection has content (default false)"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "schema:write");
			requireRole(extra, Role.ADMIN);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				await registry.deleteCollection(args.slug, { force: args.force });
				ec.invalidateManifest();
				return jsonResult({ deleted: args.slug });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"schema_create_field",
		{
			title: "Add Field to Collection",
			description:
				"Add a new field to a collection's schema. This adds a column to the " +
				"database table. Field types: string (short text), text (long text), " +
				"number (decimal), integer, boolean, datetime, select (single choice), " +
				"multiSelect (multiple), portableText (rich text), image, file, " +
				"reference (link to another collection), json, slug (URL-safe id). " +
				"For select/multiSelect, provide choices in validation.options array.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug to add the field to"),
				slug: z
					.string()
					.regex(COLLECTION_SLUG_PATTERN)
					.describe("Field identifier (lowercase letters, numbers, underscores)"),
				label: z.string().describe("Display name for the field"),
				type: z
					.enum([
						"string",
						"text",
						"number",
						"integer",
						"boolean",
						"datetime",
						"select",
						"multiSelect",
						"portableText",
						"image",
						"file",
						"reference",
						"json",
						"slug",
					])
					.describe("Data type for this field"),
				required: z.boolean().optional().describe("Whether the field is required (default false)"),
				unique: z.boolean().optional().describe("Whether values must be unique (default false)"),
				defaultValue: z.unknown().optional().describe("Default value for new items"),
				validation: z
					.object({
						min: z.number().optional(),
						max: z.number().optional(),
						minLength: z.number().optional(),
						maxLength: z.number().optional(),
						pattern: z.string().optional(),
						options: z
							.array(z.string())
							.optional()
							.describe("Allowed values for select/multiSelect"),
					})
					.optional()
					.describe("Validation constraints"),
				options: z
					.object({
						collection: z
							.string()
							.optional()
							.describe("Target collection slug for reference fields"),
						rows: z.number().optional().describe("Number of rows for textarea"),
					})
					.passthrough()
					.optional()
					.describe("Widget configuration"),
				searchable: z
					.boolean()
					.optional()
					.describe("Include in full-text search index (default false)"),
				translatable: z
					.boolean()
					.optional()
					.describe(
						"Whether this field is translatable (default true). " +
							"Non-translatable fields are synced across all locales in a translation group.",
					),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "schema:write");
			requireRole(extra, Role.ADMIN);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				const field = await registry.createField(args.collection, {
					slug: args.slug,
					label: args.label,
					type: args.type,
					required: args.required,
					unique: args.unique,
					defaultValue: args.defaultValue,
					validation: args.validation,
					options: args.options,
					searchable: args.searchable,
					translatable: args.translatable,
				});
				ec.invalidateManifest();
				return jsonResult(field);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"schema_delete_field",
		{
			title: "Remove Field from Collection",
			description:
				"Remove a field from a collection. This drops the column from the " +
				"database table and deletes all data in that field. Irreversible.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				fieldSlug: z.string().describe("Field slug to remove"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "schema:write");
			requireRole(extra, Role.ADMIN);
			const ec = getEmDash(extra);
			try {
				const { SchemaRegistry } = await import("../schema/index.js");
				const registry = new SchemaRegistry(ec.db);
				await registry.deleteField(args.collection, args.fieldSlug);
				ec.invalidateManifest();
				return jsonResult({ deleted: args.fieldSlug, collection: args.collection });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// =====================================================================
	// Media tools
	// =====================================================================

	server.registerTool(
		"media_list",
		{
			title: "List Media",
			description:
				"List uploaded media files (images, documents, etc.) with optional MIME " +
				"type filtering and pagination. Returns file metadata including filename, " +
				"URL, dimensions, and alt text.",
			inputSchema: z.object({
				mimeType: z
					.string()
					.optional()
					.describe("Filter by MIME type prefix (e.g. 'image/', 'application/pdf')"),
				limit: z.number().int().min(1).max(100).optional().describe("Max items (default 50)"),
				cursor: z.string().optional().describe("Pagination cursor"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "media:read");
			const ec = getEmDash(extra);
			return unwrap(
				await ec.handleMediaList({
					mimeType: args.mimeType,
					limit: args.limit,
					cursor: args.cursor,
				}),
			);
		},
	);

	server.registerTool(
		"media_get",
		{
			title: "Get Media Item",
			description:
				"Get details of a single media file by its ID. Returns metadata " +
				"including filename, MIME type, size, dimensions, alt text, and URL.",
			inputSchema: z.object({
				id: z.string().describe("Media item ID"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "media:read");
			const ec = getEmDash(extra);
			return unwrap(await ec.handleMediaGet(args.id));
		},
	);

	server.registerTool(
		"media_update",
		{
			title: "Update Media Metadata",
			description:
				"Update the metadata of an uploaded media file. You can change the " +
				"alt text, caption, and dimensions. The file itself cannot be changed.",
			inputSchema: z.object({
				id: z.string().describe("Media item ID"),
				alt: z.string().optional().describe("Alt text for accessibility"),
				caption: z.string().optional().describe("Caption text"),
				width: z.number().int().optional().describe("Image width in pixels"),
				height: z.number().int().optional().describe("Image height in pixels"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "media:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch media item for ownership check
			const existing = await ec.handleMediaGet(args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			const media = (existing.data as Record<string, unknown> | undefined)?.item as
				| Record<string, unknown>
				| undefined;
			const authorId = typeof media?.authorId === "string" ? media.authorId : "";
			requireOwnership(extra, authorId, "media:edit_own", "media:edit_any");

			return unwrap(
				await ec.handleMediaUpdate(args.id, {
					alt: args.alt,
					caption: args.caption,
					width: args.width,
					height: args.height,
				}),
			);
		},
	);

	server.registerTool(
		"media_delete",
		{
			title: "Delete Media",
			description:
				"Permanently delete an uploaded media file. Removes the database record " +
				"and the file from storage. Content referencing this media will have " +
				"broken references. Cannot be undone.",
			inputSchema: z.object({
				id: z.string().describe("Media item ID"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "media:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

			// Fetch media item for ownership check
			const existing = await ec.handleMediaGet(args.id);
			if (!existing.success) {
				return unwrap(existing);
			}
			const media = (existing.data as Record<string, unknown> | undefined)?.item as
				| Record<string, unknown>
				| undefined;
			const authorId = typeof media?.authorId === "string" ? media.authorId : "";
			requireOwnership(extra, authorId, "media:delete_own", "media:delete_any");

			return unwrap(await ec.handleMediaDelete(args.id));
		},
	);

	// =====================================================================
	// Search tool
	// =====================================================================

	server.registerTool(
		"search",
		{
			title: "Search Content",
			description:
				"Full-text search across content collections. Searches indexed fields " +
				"for matching content. Collections must have 'search' in their supports " +
				"list and fields must be marked as searchable. Returns collection, item " +
				"ID, title, excerpt, and relevance score.",
			inputSchema: z.object({
				query: z.string().describe("Search query text"),
				collections: z
					.array(z.string())
					.optional()
					.describe("Limit search to specific collection slugs (all if omitted)"),
				locale: z
					.string()
					.optional()
					.describe("Filter results by locale (omit to search all locales)"),
				limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				const { searchWithDb } = await import("../search/index.js");
				const results = await searchWithDb(ec.db, args.query, {
					collections: args.collections,
					locale: args.locale,
					limit: args.limit,
				});
				return jsonResult(results);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// =====================================================================
	// Taxonomy tools
	// =====================================================================

	server.registerTool(
		"taxonomy_list",
		{
			title: "List Taxonomies",
			description:
				"List all taxonomy definitions (e.g. categories, tags). Taxonomies are " +
				"classification systems applied to content. Each has a name, label, and " +
				"can be hierarchical (categories) or flat (tags).",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (_args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				const rows = (await ec.db
					.selectFrom("_emdash_taxonomy_defs" as never)
					.selectAll()
					.execute()) as Array<{
					id: string;
					name: string;
					label: string;
					label_singular: string | null;
					hierarchical: number;
					collections: string | null;
				}>;
				const taxonomies = rows.map((row) => ({
					id: row.id,
					name: row.name,
					label: row.label,
					labelSingular: row.label_singular ?? undefined,
					hierarchical: row.hierarchical === 1,
					collections: row.collections ? JSON.parse(row.collections) : [],
				}));
				return jsonResult(taxonomies);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"taxonomy_list_terms",
		{
			title: "List Taxonomy Terms",
			description:
				"List terms in a taxonomy with pagination. Terms are individual entries " +
				"(e.g. specific categories or tags). Hierarchical taxonomies can have " +
				"parent-child relationships.",
			inputSchema: z.object({
				taxonomy: z.string().describe("Taxonomy name (e.g. 'categories', 'tags')"),
				limit: z.number().int().min(1).max(100).optional().describe("Max items (default 50)"),
				cursor: z.string().optional().describe("Pagination cursor"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				const taxonomy = (await ec.db
					.selectFrom("_emdash_taxonomy_defs" as never)
					.select("id" as never)
					.where("name" as never, "=", args.taxonomy as never)
					.executeTakeFirst()) as { id: string } | undefined;

				if (!taxonomy) return errorResult(`Taxonomy '${args.taxonomy}' not found`);

				const limit = Math.min(args.limit ?? 50, 100);
				let query = ec.db
					.selectFrom("_emdash_taxonomy_terms" as never)
					.selectAll()
					.where("taxonomy_id" as never, "=", taxonomy.id as never)
					.orderBy("label" as never, "asc")
					.limit(limit + 1);

				if (args.cursor) {
					query = query.where("id" as never, ">" as never, args.cursor as never);
				}

				const rows = (await query.execute()) as Array<{ id: string }>;
				const hasMore = rows.length > limit;
				const items = hasMore ? rows.slice(0, limit) : rows;
				const nextCursor = hasMore ? items.at(-1)?.id : undefined;

				return jsonResult({ items, nextCursor });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"taxonomy_create_term",
		{
			title: "Create Taxonomy Term",
			description:
				"Create a new term in a taxonomy. For hierarchical taxonomies like " +
				"categories, you can specify a parentId to create a child term.",
			inputSchema: z.object({
				taxonomy: z.string().describe("Taxonomy name (e.g. 'categories', 'tags')"),
				slug: z.string().describe("URL-safe identifier for the term"),
				label: z.string().describe("Display name"),
				parentId: z.string().optional().describe("Parent term ID for hierarchical taxonomies"),
				description: z.string().optional().describe("Description of the term"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { ulid } = await import("ulidx");

				const taxonomy = (await ec.db
					.selectFrom("_emdash_taxonomy_defs" as never)
					.select("id" as never)
					.where("name" as never, "=", args.taxonomy as never)
					.executeTakeFirst()) as { id: string } | undefined;

				if (!taxonomy) return errorResult(`Taxonomy '${args.taxonomy}' not found`);

				const id = ulid();
				await ec.db
					.insertInto("_emdash_taxonomy_terms" as never)
					.values({
						id,
						taxonomy_id: taxonomy.id,
						slug: args.slug,
						label: args.label,
						parent_id: args.parentId ?? null,
						description: args.description ?? null,
					} as never)
					.execute();

				const term = await ec.db
					.selectFrom("_emdash_taxonomy_terms" as never)
					.selectAll()
					.where("id" as never, "=", id as never)
					.executeTakeFirstOrThrow();

				return jsonResult(term);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// =====================================================================
	// Menu tools
	// =====================================================================

	server.registerTool(
		"menu_list",
		{
			title: "List Menus",
			description:
				"List all navigation menus defined in the CMS. Menus are named " +
				"navigation structures (e.g. 'main', 'footer') containing ordered " +
				"items with labels, URLs, and optional nesting.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (_args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				const menus = await ec.db
					.selectFrom("_emdash_menus" as never)
					.select([
						"id" as never,
						"name" as never,
						"label" as never,
						"created_at" as never,
						"updated_at" as never,
					])
					.orderBy("name" as never, "asc")
					.execute();
				return jsonResult(menus);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"menu_get",
		{
			title: "Get Menu with Items",
			description:
				"Get a menu by name including all its items in order. Items have a " +
				"label, URL, type (custom/content/collection), and optional parent " +
				"for nesting.",
			inputSchema: z.object({
				name: z.string().describe("Menu name (e.g. 'main', 'footer')"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				const menu = (await ec.db
					.selectFrom("_emdash_menus" as never)
					.selectAll()
					.where("name" as never, "=", args.name as never)
					.executeTakeFirst()) as { id: string } | undefined;

				if (!menu) return errorResult(`Menu '${args.name}' not found`);

				const items = await ec.db
					.selectFrom("_emdash_menu_items" as never)
					.selectAll()
					.where("menu_id" as never, "=", menu.id as never)
					.orderBy("sort_order" as never, "asc")
					.execute();

				return jsonResult({ ...menu, items });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// =====================================================================
	// Revision tools
	// =====================================================================

	server.registerTool(
		"revision_list",
		{
			title: "List Revisions",
			description:
				"List revision history for a content item. Revisions are snapshots " +
				"created on publish or update. Returns newest-first. Requires the " +
				"collection to support 'revisions'.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
				limit: z.number().int().min(1).max(50).optional().describe("Max revisions (default 20)"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			return unwrap(
				await ec.handleRevisionList(args.collection, args.id, {
					limit: args.limit,
				}),
			);
		},
	);

	server.registerTool(
		"revision_restore",
		{
			title: "Restore Revision",
			description:
				"Restore a content item to a previous revision. Replaces the current " +
				"draft with the specified revision's data. Not automatically published — " +
				"use content_publish afterward if needed.",
			inputSchema: z.object({
				revisionId: z.string().describe("Revision ID to restore"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const { emdash, userId } = getExtra(extra);

			// Fetch the revision to discover the parent content entry
			const revision = await emdash.handleRevisionGet(args.revisionId);
			if (!revision.success) {
				return unwrap(revision);
			}
			const revItem = revision.data?.item;
			if (!revItem?.collection || !revItem?.entryId) {
				return errorResult("Revision is missing collection or entry reference");
			}

			// Fetch the content entry to check ownership
			const existing = await emdash.handleContentGet(revItem.collection, revItem.entryId);
			if (!existing.success) {
				return unwrap(existing);
			}
			requireOwnership(
				extra,
				extractContentAuthorId(existing.data),
				"content:edit_own",
				"content:edit_any",
			);

			return unwrap(await emdash.handleRevisionRestore(args.revisionId, userId));
		},
	);

	return server;
}
