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
import { canActOnOwn, hasPermission, Role } from "@emdash-cms/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { EmDashHandlers } from "../astro/types.js";
import { hasScope } from "../auth/api-tokens.js";

const COLLECTION_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HandlerResult = {
	success: boolean;
	data?: unknown;
	error?: unknown;
};

type SuccessEnvelope = {
	content: Array<{ type: "text"; text: string }>;
	_meta?: Record<string, unknown>;
};

type ErrorEnvelope = {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	_meta: { code: string; details?: Record<string, unknown> };
};

/**
 * Return a successful tool response with the data as pretty-printed JSON.
 */
function respondData(data: unknown): SuccessEnvelope {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}

/**
 * Return a structured error tool response.
 *
 * The error code is emitted both in the human-readable message (as a stable
 * `[CODE]` prefix that callers can match on) and in `_meta.code` so MCP-aware
 * clients can read it programmatically once the SDK supports forwarding meta.
 */
function respondError(
	code: string,
	message: string,
	details?: Record<string, unknown>,
): ErrorEnvelope {
	const text = `[${code}] ${message}`;
	const meta: { code: string; details?: Record<string, unknown> } = { code };
	if (details !== undefined) meta.details = details;
	return {
		content: [{ type: "text", text }],
		isError: true,
		_meta: meta,
	};
}

/**
 * Auth/permission errors thrown from `requireScope` / `requireRole` /
 * `requireOwnership` / `requireDraftAccess`. Carries a stable string `code`
 * field so `respondHandlerError` can surface it through `_meta.code` and
 * the message prefix.
 *
 * Distinct from `McpError` (which the SDK catches at JSON-RPC level — the
 * code there is numeric, not a stable EmDash error code).
 */
class EmDashAuthError extends Error {
	override readonly name = "EmDashAuthError";
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

/**
 * Map an unknown thrown error to a structured error envelope.
 *
 * Recognises (in priority order):
 *  - `EmDashAuthError` — `code` is a stable EmDash auth code
 *    (`UNAUTHORIZED`, `INSUFFICIENT_SCOPE`, `INSUFFICIENT_PERMISSIONS`).
 *  - `Error` objects with an `apiError: { code, details? }` annotation
 *    (handlers throw these for NOT_FOUND / CONFLICT inside transactions;
 *    see `api/handlers/content.ts:538`).
 *  - `SchemaError` (and any error with a string `code` field) — the code
 *    is forwarded verbatim. `details` is forwarded too if present.
 *  - Plain `Error` instances — message preserved, code falls back to
 *    `fallbackCode` (or `INTERNAL_ERROR`).
 *  - Strings — used directly as the message.
 *  - Anything else — coerced via `String()`.
 *
 * The original message is always preserved so tests and humans can see the
 * specific failure cause. Numeric `code` values (e.g. on `McpError`) are
 * ignored — the field is reserved for stable string codes.
 */
function respondHandlerError(error: unknown, fallbackCode = "INTERNAL_ERROR"): ErrorEnvelope {
	let code = fallbackCode;
	let message: string;
	let details: Record<string, unknown> | undefined;

	if (error instanceof EmDashAuthError) {
		message = error.message || fallbackCode;
		code = error.code;
	} else if (error instanceof Error) {
		message = error.message || fallbackCode;
		const apiError = (error as { apiError?: { code?: string; details?: unknown } }).apiError;
		if (apiError && typeof apiError.code === "string" && apiError.code) {
			code = apiError.code;
			if (apiError.details && typeof apiError.details === "object") {
				details = apiError.details as Record<string, unknown>;
			}
		} else {
			// Errors that carry their own `code` (SchemaError, custom errors).
			// Skip numeric codes (McpError, Node fs errors) — `_meta.code` is
			// reserved for stable string codes.
			const rawCode = (error as { code?: unknown }).code;
			if (typeof rawCode === "string" && rawCode) {
				code = rawCode;
			}
			const rawDetails = (error as { details?: unknown }).details;
			if (rawDetails && typeof rawDetails === "object") {
				details = rawDetails as Record<string, unknown>;
			}
		}
	} else if (typeof error === "string") {
		message = error;
	} else {
		message = String(error);
	}

	return respondError(code, message, details);
}

/**
 * Unwrap an ApiResult<T> into MCP tool result format.
 *
 * On success returns the data as JSON. On failure propagates the structured
 * `{ code, message, details }` from the handler so the caller sees both a
 * machine-readable code (in `_meta.code` and as a `[CODE]` message prefix)
 * and the original human-readable message.
 */
function unwrap(result: HandlerResult): SuccessEnvelope | ErrorEnvelope {
	if (result.success && result.data !== undefined) {
		return respondData(result.data);
	}
	const err =
		result.error && typeof result.error === "object"
			? (result.error as { code?: unknown; message?: unknown; details?: unknown })
			: undefined;
	if (!err) return respondError("INTERNAL_ERROR", "Unknown error");
	const code = typeof err.code === "string" && err.code ? err.code : "INTERNAL_ERROR";
	const message = typeof err.message === "string" && err.message ? err.message : "Unknown error";
	const details =
		err.details && typeof err.details === "object"
			? (err.details as Record<string, unknown>)
			: undefined;
	return respondError(code, message, details);
}

/**
 * Return a JSON text block (success path for tools that don't go through
 * the ApiResult-returning handler layer, e.g. schema/menu/taxonomy).
 */
function jsonResult(data: unknown): SuccessEnvelope {
	return respondData(data);
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

function isPublished(t: unknown): boolean {
	return (
		typeof t === "object" &&
		t !== null &&
		"status" in t &&
		(t as Record<string, unknown>).status === "published"
	);
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
		throw new EmDashAuthError(`Insufficient scope: requires ${scope}`, "INSUFFICIENT_SCOPE");
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
		throw new EmDashAuthError(
			"Insufficient permissions for this operation",
			"INSUFFICIENT_PERMISSIONS",
		);
	}
}

/**
 * Whether the current user may read non-published content (drafts, scheduled,
 * trashed, revisions, compare). SUBSCRIBER may hold content:read for
 * member-only published content but must not see drafts.
 */
function canReadDrafts(extra: { authInfo?: { extra?: Record<string, unknown> } }): boolean {
	const payload = getExtra(extra);
	return hasPermission({ role: payload.userRole }, "content:read_drafts");
}

/**
 * Throw if the current user cannot read non-published content. Used by
 * editor-only views (revisions, compare, trash, preview-url).
 */
function requireDraftAccess(extra: { authInfo?: { extra?: Record<string, unknown> } }): void {
	if (!canReadDrafts(extra)) {
		throw new EmDashAuthError(
			"Insufficient permissions for this operation",
			"INSUFFICIENT_PERMISSIONS",
		);
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
		throw new EmDashAuthError(
			"Insufficient permissions for this operation",
			"INSUFFICIENT_PERMISSIONS",
		);
	}
}

/**
 * Extract the author ID from a content handler response.
 *
 * Content handlers return `{ item: { id, authorId, ... }, _rev? }`.
 * This helper navigates that shape safely. Returns "" when authorId is
 * missing or non-string (e.g. seed-imported content with no author);
 * `canActOnOwn` then decides based on the caller's permissions —
 * an actor with `*:edit_any` succeeds, an actor with only `*:edit_own`
 * is denied with a clean permission error.
 */
function extractContentAuthorId(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const obj = data as Record<string, unknown>;
	const item =
		obj.item && typeof obj.item === "object" ? (obj.item as Record<string, unknown>) : obj;
	return typeof item?.authorId === "string" ? item.authorId : "";
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

	// Wrap every tool registration's callback so EmDashAuthError throws
	// (from requireScope / requireRole / requireOwnership / requireDraftAccess)
	// surface as structured `_meta.code`-bearing tool error envelopes
	// instead of the SDK's text-only fallback in createToolError().
	//
	// Type-erased on purpose — the SDK's overloads are too narrow for a
	// generic wrapper, but the runtime contract (callback returns the tool
	// result envelope) holds for every registered tool.
	const originalRegisterTool = server.registerTool.bind(server);
	(server as { registerTool: typeof server.registerTool }).registerTool = ((
		name: string,
		config: unknown,
		callback: (...callbackArgs: unknown[]) => Promise<SuccessEnvelope | ErrorEnvelope>,
	) => {
		const wrapped = async (
			...callbackArgs: unknown[]
		): Promise<SuccessEnvelope | ErrorEnvelope> => {
			try {
				return await callback(...callbackArgs);
			} catch (error) {
				return respondHandlerError(error, "INTERNAL_ERROR");
			}
		};
		return (
			originalRegisterTool as unknown as (n: string, c: unknown, cb: typeof wrapped) => unknown
		)(name, config, wrapped);
	}) as typeof server.registerTool;

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
				cursor: z
					.string()
					.min(1)
					.max(2048)
					.optional()
					.describe("Pagination cursor from a previous response"),
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
			// Subscribers must only see published content; force the status
			// filter regardless of caller-supplied value.
			const status = canReadDrafts(extra) ? args.status : "published";
			return unwrap(
				await ec.handleContentList(args.collection, {
					status,
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
			const result = await ec.handleContentGet(args.collection, args.id, args.locale);
			// Hide non-published items from users without draft access. Return a
			// not-found error so subscribers can't enumerate draft IDs by status.
			if (result.success && !canReadDrafts(extra)) {
				const data =
					result.data && typeof result.data === "object"
						? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check
							(result.data as Record<string, unknown>)
						: undefined;
				const item =
					data?.item && typeof data.item === "object"
						? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check
							(data.item as Record<string, unknown>)
						: undefined;
				const status = typeof item?.status === "string" ? item.status : null;
				if (status !== "published") {
					return unwrap({
						success: false,
						error: { code: "NOT_FOUND", message: `Content item not found: ${args.id}` },
					});
				}
			}
			return unwrap(result);
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
					.describe("Initial status (default 'draft'). Requires publish permission."),
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

			// Creating a translation requires edit permission on the source item
			if (args.translationOf) {
				const source = await emdash.handleContentGet(args.collection, args.translationOf);
				if (!source.success) return unwrap(source);
				requireOwnership(
					extra,
					extractContentAuthorId(source.data),
					"content:edit_own",
					"content:edit_any",
				);
			}

			// Publishing requires publish permission — create as draft then publish
			if (args.status === "published") {
				const user = { id: userId, role: getExtra(extra).userRole };
				if (!hasPermission(user, "content:publish_own" as Permission)) {
					throw new EmDashAuthError(
						"Insufficient permissions: publishing requires content:publish_own",
						"INSUFFICIENT_PERMISSIONS",
					);
				}
				const result = await emdash.handleContentCreate(args.collection, {
					data: args.data,
					slug: args.slug,
					authorId: userId,
					locale: args.locale,
					translationOf: args.translationOf,
				});
				if (!result.success) return unwrap(result);
				const itemId = extractContentId(result.data);
				if (itemId) {
					return unwrap(await emdash.handleContentPublish(args.collection, itemId));
				}
				return unwrap(result);
			}

			return unwrap(
				await emdash.handleContentCreate(args.collection, {
					data: args.data,
					slug: args.slug,
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
				status: z
					.enum(["draft", "published"])
					.optional()
					.describe(
						"New status. Setting to 'published' requires publish permission. Setting to 'draft' unpublishes the item and also requires publish permission.",
					),
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

			// Status transitions route through dedicated handlers for proper revision management
			if (args.status === "published") {
				requireOwnership(
					extra,
					extractContentAuthorId(existing.data),
					"content:publish_own",
					"content:publish_any",
				);
				if (args.data || args.slug) {
					const updateResult = await emdash.handleContentUpdate(args.collection, resolvedId, {
						data: args.data,
						slug: args.slug,
						authorId: userId,
						_rev: args._rev,
					});
					if (!updateResult.success) return unwrap(updateResult);
				}
				return unwrap(await emdash.handleContentPublish(args.collection, resolvedId));
			}

			if (args.status === "draft") {
				requireOwnership(
					extra,
					extractContentAuthorId(existing.data),
					"content:publish_own",
					"content:publish_any",
				);
				if (args.data || args.slug) {
					const updateResult = await emdash.handleContentUpdate(args.collection, resolvedId, {
						data: args.data,
						slug: args.slug,
						authorId: userId,
						_rev: args._rev,
					});
					if (!updateResult.success) return unwrap(updateResult);
				}
				return unwrap(await emdash.handleContentUnpublish(args.collection, resolvedId));
			}

			return unwrap(
				await emdash.handleContentUpdate(args.collection, resolvedId, {
					data: args.data,
					slug: args.slug,
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
		"content_unschedule",
		{
			title: "Cancel Scheduled Publication",
			description:
				"Cancel a previously scheduled publication. The item remains in its current " +
				"status (typically 'draft' or 'scheduled'); only the scheduledAt timestamp is " +
				"cleared. Idempotent — calling on an item that isn't scheduled is a no-op.",
			inputSchema: z.object({
				collection: z.string().describe("Collection slug"),
				id: z.string().describe("Content item ID or slug"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "content:write");
			requireRole(extra, Role.AUTHOR);
			const ec = getEmDash(extra);

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
			return unwrap(await ec.handleContentUnschedule(args.collection, resolvedId));
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
			requireDraftAccess(extra);
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
				cursor: z.string().min(1).max(2048).optional().describe("Pagination cursor"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			requireDraftAccess(extra);
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
			const result = await ec.handleContentTranslations(args.collection, args.id);
			// Filter out non-published translations for users without draft
			// access so a subscriber can't enumerate locales that aren't yet live.
			if (result.success && !canReadDrafts(extra)) {
				const data =
					result.data && typeof result.data === "object"
						? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check
							(result.data as Record<string, unknown>)
						: undefined;
				const translations = Array.isArray(data?.translations) ? data.translations : [];
				const filtered = translations.filter(isPublished);
				return unwrap({
					success: true,
					data: { ...data, translations: filtered },
				});
			}
			return unwrap(result);
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
				return respondHandlerError(error, "SCHEMA_LIST_ERROR");
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
					return respondError("NOT_FOUND", `Collection '${args.slug}' not found`);
				}
				return jsonResult(collection);
			} catch (error) {
				return respondHandlerError(error, "SCHEMA_GET_ERROR");
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
					// SchemaRegistry.createCollection now defaults `supports` to
					// ['drafts', 'revisions'] when undefined; pass through verbatim.
					supports: args.supports,
				});
				ec.invalidateManifest();
				return jsonResult(collection);
			} catch (error) {
				return respondHandlerError(error, "SCHEMA_CREATE_ERROR");
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
				return respondHandlerError(error, "SCHEMA_DELETE_ERROR");
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
				return respondHandlerError(error, "FIELD_CREATE_ERROR");
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
				return respondHandlerError(error, "FIELD_DELETE_ERROR");
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
				cursor: z.string().min(1).max(2048).optional().describe("Pagination cursor"),
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
		"media_create",
		{
			title: "Register Uploaded Media",
			description:
				"Register a media file that has already been uploaded to storage. The " +
				"caller is responsible for placing the file at `storageKey` (typically " +
				"using a signed upload URL obtained from the admin UI or a separate API). " +
				"This tool persists the metadata record so the file is discoverable via " +
				"media_list / media_get and can be referenced by content. For binary " +
				"uploads the MCP transport is not appropriate — use the signed-upload " +
				"flow instead.",
			inputSchema: z.object({
				filename: z.string().describe("Original filename (e.g. 'logo.png')"),
				mimeType: z.string().describe("MIME type (e.g. 'image/png')"),
				storageKey: z.string().describe("Storage path/key the file was uploaded to"),
				size: z.number().int().nonnegative().optional().describe("File size in bytes"),
				width: z.number().int().positive().optional().describe("Image width in pixels"),
				height: z.number().int().positive().optional().describe("Image height in pixels"),
				contentHash: z.string().optional().describe("Hash of the file contents (for dedupe)"),
				blurhash: z.string().optional().describe("Blurhash for image placeholders"),
				dominantColor: z
					.string()
					.optional()
					.describe("Hex color string for the image's dominant color"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "media:write");
			requireRole(extra, Role.AUTHOR);
			const { emdash, userId } = getExtra(extra);
			return unwrap(
				await emdash.handleMediaCreate({
					filename: args.filename,
					mimeType: args.mimeType,
					storageKey: args.storageKey,
					size: args.size,
					width: args.width,
					height: args.height,
					contentHash: args.contentHash,
					blurhash: args.blurhash,
					dominantColor: args.dominantColor,
					authorId: userId,
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
				return respondHandlerError(error, "SEARCH_ERROR");
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
				const { handleTaxonomyList } = await import("../api/handlers/taxonomies.js");
				return unwrap(await handleTaxonomyList(ec.db));
			} catch (error) {
				return respondHandlerError(error, "TAXONOMY_LIST_ERROR");
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
				cursor: z.string().min(1).max(2048).optional().describe("Pagination cursor"),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "content:read");
			const ec = getEmDash(extra);
			try {
				// Verify taxonomy exists via handler layer
				const { handleTaxonomyList } = await import("../api/handlers/taxonomies.js");
				const listResult = await handleTaxonomyList(ec.db);
				if (!listResult.success) return unwrap(listResult);

				const taxonomies = (listResult.data as { taxonomies: Array<{ name: string; id?: string }> })
					.taxonomies;
				const taxonomy = taxonomies.find((t: { name: string }) => t.name === args.taxonomy);
				if (!taxonomy) return respondError("NOT_FOUND", `Taxonomy '${args.taxonomy}' not found`);

				// Paginated term query via repository (avoids N+1 of handleTermList)
				const { TaxonomyRepository } = await import("../database/repositories/taxonomy.js");
				const { decodeCursor, encodeCursor, InvalidCursorError } =
					await import("../database/repositories/types.js");
				const repo = new TaxonomyRepository(ec.db);
				const limit = Math.min(args.limit ?? 50, 100);
				const terms = await repo.findByName(args.taxonomy);

				// Manual keyset pagination over the sorted-by-label results.
				// Using a base64-encoded `(label, id)` cursor matches the
				// scheme other list endpoints use and tolerates concurrent
				// deletion of the cursor-term — the cursor is a position,
				// not a row reference, so a missing row just means we skip
				// past it rather than erroring.
				let startIdx = 0;
				if (args.cursor) {
					let decoded: { orderValue: string; id: string };
					try {
						decoded = decodeCursor(args.cursor);
					} catch (error) {
						if (error instanceof InvalidCursorError) {
							return respondError("INVALID_CURSOR", error.message);
						}
						throw error;
					}
					// Find the first term that sorts strictly after the cursor
					// position. Stable order is `(label asc, id asc)` so a
					// `(label, id)` tuple comparison is the keyset.
					startIdx = terms.findIndex(
						(t) =>
							t.label > decoded.orderValue || (t.label === decoded.orderValue && t.id > decoded.id),
					);
					if (startIdx < 0) startIdx = terms.length;
				}

				const page = terms.slice(startIdx, startIdx + limit);
				const hasMore = startIdx + limit < terms.length;
				const last = page.at(-1);
				const nextCursor = hasMore && last ? encodeCursor(last.label, last.id) : undefined;

				return jsonResult({
					items: page.map((t) => ({
						id: t.id,
						name: t.name,
						slug: t.slug,
						label: t.label,
						parentId: t.parentId,
						description: typeof t.data?.description === "string" ? t.data.description : undefined,
					})),
					nextCursor,
				});
			} catch (error) {
				return respondHandlerError(error, "TAXONOMY_LIST_TERMS_ERROR");
			}
		},
	);

	server.registerTool(
		"taxonomy_create_term",
		{
			title: "Create Taxonomy Term",
			description:
				"Create a new term in a taxonomy. For hierarchical taxonomies like " +
				"categories, you can specify a parentId to create a child term. The " +
				"parent must exist and belong to the same taxonomy. Parent chains are " +
				"limited to 100 ancestors deep.",
			inputSchema: z.object({
				taxonomy: z.string().describe("Taxonomy name (e.g. 'categories', 'tags')"),
				slug: z.string().describe("URL-safe identifier for the term"),
				label: z.string().describe("Display name"),
				parentId: z.string().optional().describe("Parent term ID for hierarchical taxonomies"),
				description: z.string().optional().describe("Description of the term"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "taxonomies:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleTermCreate } = await import("../api/handlers/taxonomies.js");
				return unwrap(
					await handleTermCreate(ec.db, args.taxonomy, {
						slug: args.slug,
						label: args.label,
						parentId: args.parentId,
						description: args.description,
					}),
				);
			} catch (error) {
				return respondHandlerError(error, "TAXONOMY_TERM_CREATE_ERROR");
			}
		},
	);

	server.registerTool(
		"taxonomy_update_term",
		{
			title: "Update Taxonomy Term",
			description:
				"Update an existing term in a taxonomy. Any field can be omitted to leave " +
				"it unchanged. Renaming a term's slug must not collide with another term in " +
				"the same taxonomy. Set parentId to null to detach from a parent. The new " +
				"parent must exist, belong to the same taxonomy, and not introduce a cycle " +
				"(a term cannot be its own ancestor). Parent chains are limited to 100 " +
				"ancestors deep.",
			inputSchema: z.object({
				taxonomy: z.string().describe("Taxonomy name (e.g. 'categories', 'tags')"),
				termSlug: z.string().describe("Current slug of the term to update"),
				slug: z.string().optional().describe("New slug (must be unique in the taxonomy)"),
				label: z.string().optional().describe("New display name"),
				parentId: z.string().nullable().optional().describe("New parent term ID; null to detach"),
				description: z.string().optional().describe("New description"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "taxonomies:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleTermUpdate } = await import("../api/handlers/taxonomies.js");
				return unwrap(
					await handleTermUpdate(ec.db, args.taxonomy, args.termSlug, {
						slug: args.slug,
						label: args.label,
						parentId: args.parentId,
						description: args.description,
					}),
				);
			} catch (error) {
				return respondHandlerError(error, "TAXONOMY_TERM_UPDATE_ERROR");
			}
		},
	);

	server.registerTool(
		"taxonomy_delete_term",
		{
			title: "Delete Taxonomy Term",
			description:
				"Permanently delete a term from a taxonomy. Any content tagged with this " +
				"term loses the association. Cannot delete a term that has children — " +
				"delete children first.",
			inputSchema: z.object({
				taxonomy: z.string().describe("Taxonomy name"),
				termSlug: z.string().describe("Slug of the term to delete"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "taxonomies:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleTermDelete } = await import("../api/handlers/taxonomies.js");
				return unwrap(await handleTermDelete(ec.db, args.taxonomy, args.termSlug));
			} catch (error) {
				return respondHandlerError(error, "TAXONOMY_TERM_DELETE_ERROR");
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
				const { handleMenuList } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuList(ec.db));
			} catch (error) {
				return respondHandlerError(error, "MENU_LIST_ERROR");
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
				const { handleMenuGet } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuGet(ec.db, args.name));
			} catch (error) {
				return respondHandlerError(error, "MENU_GET_ERROR");
			}
		},
	);

	server.registerTool(
		"menu_create",
		{
			title: "Create Menu",
			description:
				"Create a new navigation menu. The `name` is the stable identifier used " +
				"by site templates (e.g. 'main', 'footer'); `label` is the human-readable " +
				"name shown in the admin. Add items afterwards with menu_set_items.",
			inputSchema: z.object({
				name: z
					.string()
					.regex(COLLECTION_SLUG_PATTERN)
					.describe("Stable identifier (lowercase letters, numbers, underscores)"),
				label: z.string().describe("Display name for the admin"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "menus:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleMenuCreate } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuCreate(ec.db, { name: args.name, label: args.label }));
			} catch (error) {
				return respondHandlerError(error, "MENU_CREATE_ERROR");
			}
		},
	);

	server.registerTool(
		"menu_update",
		{
			title: "Update Menu",
			description: "Update a menu's label. The `name` (stable identifier) cannot be changed.",
			inputSchema: z.object({
				name: z.string().describe("Menu name to update"),
				label: z.string().describe("New display label"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "menus:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleMenuUpdate } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuUpdate(ec.db, args.name, { label: args.label }));
			} catch (error) {
				return respondHandlerError(error, "MENU_UPDATE_ERROR");
			}
		},
	);

	server.registerTool(
		"menu_delete",
		{
			title: "Delete Menu",
			description: "Delete a menu. Items are also removed. Cannot be undone.",
			inputSchema: z.object({
				name: z.string().describe("Menu name to delete"),
			}),
			annotations: { destructiveHint: true },
		},
		async (args, extra) => {
			requireScope(extra, "menus:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleMenuDelete } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuDelete(ec.db, args.name));
			} catch (error) {
				return respondHandlerError(error, "MENU_DELETE_ERROR");
			}
		},
	);

	server.registerTool(
		"menu_set_items",
		{
			title: "Set Menu Items",
			description:
				"Replace the entire item list of a menu in one call. This is atomic: the " +
				"existing items are deleted and the new list is inserted in the order " +
				"provided. Use this rather than per-item add/remove tools so the resulting " +
				"order and parent links are unambiguous.",
			inputSchema: z.object({
				name: z.string().describe("Menu name to update"),
				items: z
					.array(
						z.object({
							label: z.string().describe("Item display text"),
							type: z
								.enum(["custom", "page", "post", "taxonomy", "collection"])
								.describe("Item kind"),
							customUrl: z
								.string()
								.optional()
								.describe("URL for type='custom' items (ignored otherwise)"),
							referenceCollection: z
								.string()
								.optional()
								.describe("Target collection slug for content references"),
							referenceId: z.string().optional().describe("Target content/term ID for references"),
							titleAttr: z.string().optional().describe("HTML title attribute"),
							target: z.string().optional().describe("HTML target attribute, e.g. '_blank'"),
							cssClasses: z.string().optional().describe("Space-separated CSS classes"),
							/**
							 * Items are positioned by array index, but parents may be referenced
							 * by their array index — items with `parentIndex` set are nested under
							 * the item at that position. Items without `parentIndex` are top-level.
							 */
							parentIndex: z
								.number()
								.int()
								.nonnegative()
								.optional()
								.describe(
									"Array index of the parent item (must be earlier in the list). Omit for top-level items.",
								),
						}),
					)
					.describe("Ordered list of menu items"),
			}),
		},
		async (args, extra) => {
			requireScope(extra, "menus:manage");
			requireRole(extra, Role.EDITOR);
			const ec = getEmDash(extra);
			try {
				const { handleMenuSetItems } = await import("../api/handlers/menus.js");
				return unwrap(await handleMenuSetItems(ec.db, args.name, args.items));
			} catch (error) {
				return respondHandlerError(error, "MENU_SET_ITEMS_ERROR");
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
			requireDraftAccess(extra);
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
				return respondError(
					"VALIDATION_ERROR",
					"Revision is missing collection or entry reference",
				);
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
