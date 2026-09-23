import { getLocaleDir, resolveLocale } from "@emdash-cms/admin/locales";
import { Permissions, type Permission, type RoleLevel } from "@emdash-cms/auth";
import { validateContentEditorPanelInteraction } from "@emdash-cms/blocks/server";

import { requirePerm, requireOwnerPerm } from "../api/authorize.js";
import { apiError, apiSuccess } from "../api/error.js";
import { requireScope } from "../auth/scopes.js";
import type { EmDashRuntime, PluginEditorExtensionDispatch } from "../emdash-runtime.js";
import {
	validateEditorDraftPatch,
	validateEditorDraftRequest,
	type ValidatedEditorDraftRequest,
} from "./editor-draft.js";
import { pluginRouteResponseFromWire, pluginRouteResponseToWire } from "./route-wire.js";
import { parseDeclaredPluginRouteInput, PluginRouteRequestError } from "./route-wire.js";
import type { PluginContentCacheInvalidator, RouteMeta } from "./routes.js";
import type { UserInfo } from "./types.js";

function editorDraftErrorResponse(error: { code: string; message: string }): Response {
	const status =
		error.code === "EDITOR_DRAFT_STALE"
			? 409
			: error.code === "EDITOR_DRAFT_FIELD_FORBIDDEN" ||
				  error.code === "EDITOR_DRAFT_CAPABILITY_REQUIRED"
				? 403
				: error.code === "EDITOR_DRAFT_TOO_LARGE"
					? 413
					: error.code === "EDITOR_DRAFT_UNSUPPORTED_FIELD_TYPE"
						? 422
						: 400;
	return apiError(error.code, error.message, status);
}

function toRoleLevel(value: number): RoleLevel | null {
	if (value === 10 || value === 20 || value === 30 || value === 40 || value === 50) {
		return value;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermission(value: string): value is Permission {
	return Object.hasOwn(Permissions, value);
}

function authorizePrivatePluginRouteRequest(
	routeMeta: RouteMeta,
	request: Request,
	user?: UserInfo | null,
	tokenScopes?: string[],
): Response | null {
	const permission = routeMeta.permission ?? "plugins:manage";
	if (!isPermission(permission)) {
		return apiError("INVALID_PLUGIN_ROUTE", "Plugin route declares an invalid permission", 500);
	}

	let permissionUser: { id: string; role: RoleLevel } | null | undefined;
	if (user) {
		const role = toRoleLevel(user.role);
		if (role === null) {
			return apiError("INVALID_USER", "Authenticated user has an invalid role", 500);
		}
		permissionUser = { id: user.id, role };
	} else {
		permissionUser = user;
	}

	const denied = requirePerm(permissionUser, permission);
	if (denied) return denied;
	const scopeError = requireScope({ tokenScopes }, "admin");
	if (scopeError) return scopeError;
	if (!tokenScopes && request.headers.get("X-EmDash-Request") !== "1") {
		return apiError("CSRF_REJECTED", "Missing required header", 403);
	}
	return null;
}

export interface PluginApiRequestContext {
	runtime: EmDashRuntime;
	pluginId: string;
	path: string;
	request: Request;
	user?: UserInfo | null;
	tokenScopes?: string[];
	invalidateContentCache?: PluginContentCacheInvalidator;
	editorDispatch?: PluginEditorExtensionDispatch;
}

/** Dispatch a request through the production plugin-route policy boundary. */
export async function dispatchPluginApiRequest({
	runtime,
	pluginId,
	path,
	request,
	user,
	tokenScopes,
	invalidateContentCache,
	editorDispatch,
}: PluginApiRequestContext): Promise<Response> {
	const method = request.method.toUpperCase();
	const routeMeta = runtime.getPluginRouteMeta(pluginId, path);
	if (!routeMeta) return apiError("NOT_FOUND", "Plugin route not found", 404);

	if (!routeMeta.public) {
		const denied = authorizePrivatePluginRouteRequest(routeMeta, request, user, tokenScopes);
		if (denied) return denied;
	}
	if (routeMeta.methods && !routeMeta.methods.some((allowed) => allowed === method)) {
		const response = apiError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
		response.headers.set("Allow", routeMeta.methods.join(", "));
		return response;
	}

	const caller = routeMeta.public ? undefined : (user ?? undefined);
	const result = await runtime.handlePluginApiRoute(
		pluginId,
		method,
		path,
		request,
		caller,
		invalidateContentCache,
		editorDispatch,
	);
	if (!result.success) {
		const code = result.error?.code ?? "PLUGIN_ERROR";
		const message =
			code === "INTERNAL_ERROR"
				? "Plugin route error"
				: (result.error?.message ?? "Plugin route error");
		const status = (result as { status?: number }).status ?? (code === "NOT_FOUND" ? 404 : 400);
		return apiError(code, message, status);
	}

	let response: Response;
	if (routeMeta.response === "raw") {
		try {
			response = pluginRouteResponseFromWire(
				await pluginRouteResponseToWire(
					result.data,
					routeMeta.public ? { publicRequestUrl: request.url } : { allowExternalLocation: true },
				),
				method,
			);
		} catch (error) {
			console.error(`[plugin:${pluginId}] Invalid raw route response:`, error);
			return apiError("INVALID_PLUGIN_RESPONSE", "Plugin returned an invalid response", 500);
		}
	} else {
		response = apiSuccess(result.data);
	}
	if (
		response.ok &&
		routeMeta.public &&
		routeMeta.cacheControl &&
		(method === "GET" || method === "HEAD")
	) {
		response.headers.set("Cache-Control", routeMeta.cacheControl);
	} else {
		response.headers.set("Cache-Control", "private, no-store");
	}
	return response;
}

export interface PluginEditorExtensionApiRequestContext {
	runtime: EmDashRuntime;
	pluginId: string;
	kind: "panel" | "action";
	extensionId: string;
	collection: string;
	entryId: string;
	request: Request;
	user?: UserInfo | null;
	tokenScopes?: string[];
	invalidateContentCache?: PluginContentCacheInvalidator;
}

const EDITOR_EXTENSION_REQUEST_MAX_BYTES = 256 * 1024;

/** Dispatch a saved-entry extension through ownership, route, and isolate policy. */
export async function dispatchPluginEditorExtensionApiRequest({
	runtime,
	pluginId,
	kind,
	extensionId,
	collection,
	entryId,
	request,
	user,
	tokenScopes,
	invalidateContentCache,
}: PluginEditorExtensionApiRequestContext): Promise<Response> {
	const definition = runtime.getPluginEditorExtension(pluginId, kind, extensionId, collection);
	if (!definition) return apiError("NOT_FOUND", "Plugin editor extension not found", 404);

	const routeMeta = runtime.getPluginRouteMeta(pluginId, definition.extension.route);
	if (!routeMeta || routeMeta.public) {
		return apiError(
			"INVALID_PLUGIN_EDITOR_EXTENSION",
			"Plugin editor extension must reference a private route",
			500,
		);
	}
	const denied = authorizePrivatePluginRouteRequest(routeMeta, request, user, tokenScopes);
	if (denied) return denied;

	const requestedLocale = new URL(request.url).searchParams.get("locale") || undefined;
	const contentResult = await runtime.handleContentGet(collection, entryId, requestedLocale);
	if (!contentResult.success) {
		return contentResult.error?.code === "NOT_FOUND"
			? apiError("NOT_FOUND", "Content item not found", 404)
			: apiError("CONTENT_GET_ERROR", "Failed to load content item", 500);
	}
	const contentData = contentResult.data;
	const item =
		typeof contentData === "object" && contentData !== null && "item" in contentData
			? contentData.item
			: null;
	if (typeof item !== "object" || item === null) {
		return apiError("CONTENT_GET_ERROR", "Failed to load content item", 500);
	}
	const authorId = "authorId" in item && typeof item.authorId === "string" ? item.authorId : "";
	let ownershipUser: { id: string; role: RoleLevel } | null | undefined =
		user == null ? user : undefined;
	if (user) {
		const ownerRole = toRoleLevel(user.role);
		if (ownerRole === null) {
			return apiError("INVALID_USER", "Authenticated user has an invalid role", 500);
		}
		ownershipUser = { id: user.id, role: ownerRole };
	}
	const ownershipDenied = requireOwnerPerm(
		ownershipUser,
		authorId,
		"content:edit_own",
		"content:edit_any",
	);
	if (ownershipDenied) return ownershipDenied;

	const canonicalId = "id" in item && typeof item.id === "string" ? item.id : null;
	const canonicalLocale = "locale" in item && typeof item.locale === "string" ? item.locale : null;
	const version = "version" in item && typeof item.version === "number" ? item.version : null;
	const baseRevision =
		typeof contentData === "object" &&
		contentData !== null &&
		"_rev" in contentData &&
		typeof contentData._rev === "string"
			? contentData._rev
			: null;
	if (!canonicalId || version === null) {
		return apiError("CONTENT_GET_ERROR", "Content item has invalid identity", 500);
	}

	let input: Record<string, unknown>;
	let editorBody: unknown;
	try {
		editorBody = await parseDeclaredPluginRouteInput(request, {
			body: "json",
			maxBytes: EDITOR_EXTENSION_REQUEST_MAX_BYTES,
		});
	} catch (error) {
		if (error instanceof PluginRouteRequestError) {
			return apiError(
				error.status === 413 ? "EDITOR_DRAFT_TOO_LARGE" : "INVALID_REQUEST",
				error.status === 413
					? "Editor interaction exceeds the size limit"
					: "Invalid editor interaction",
				error.status,
			);
		}
		return apiError("INVALID_REQUEST", "Editor interaction could not be read", 400);
	}
	if (kind === "panel") {
		if (!isRecord(editorBody)) {
			return apiError("INVALID_REQUEST", "Editor panel interaction must be an object", 400);
		}
		input = editorBody;
		const validation = validateContentEditorPanelInteraction(input);
		if (!validation.valid) {
			return apiError("INVALID_PLUGIN_UI_CONTEXT", "Invalid editor panel interaction", 400);
		}
	} else {
		if (!isRecord(editorBody)) {
			return apiError("INVALID_REQUEST", "Invalid editor action interaction", 400);
		}
		input = {
			type: "editor_action",
			...(Object.hasOwn(editorBody, "draft") ? { draft: editorBody.draft } : {}),
		};
	}

	let validatedDraft: ValidatedEditorDraftRequest | null = null;
	if (input.draft !== undefined) {
		if (!baseRevision) {
			return apiError("EDITOR_DRAFT_INVALID", "Content item has no draft revision identity", 409);
		}
		const collectionSchema = await runtime.getPluginEditorDraftSchema(collection);
		if (!collectionSchema) return apiError("NOT_FOUND", "Collection not found", 404);
		const draft = validateEditorDraftRequest({
			request: input.draft,
			collection: collectionSchema,
			entry: { id: canonicalId, locale: canonicalLocale, revision: baseRevision },
			readSelector: definition.extension.draft?.read,
			patchSelector: definition.extension.draft?.patch,
			canRead: definition.capabilities.includes("admin.editor-draft:read"),
			canPatch: definition.capabilities.includes("admin.editor-draft:patch"),
		});
		if ("code" in draft) {
			console.warn(
				`[plugin:${pluginId}] Editor draft ${kind}/${extensionId} rejected: ${draft.code}`,
			);
			return editorDraftErrorResponse(draft);
		}
		validatedDraft = draft;
		input = { ...input, draft: draft.snapshot };
	}

	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.set("Content-Type", "application/json");
	const pluginRequest = new Request(request.url, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	const locale = resolveLocale(request);
	const response = await dispatchPluginApiRequest({
		runtime,
		pluginId,
		path: definition.extension.route,
		request: pluginRequest,
		user,
		tokenScopes,
		invalidateContentCache,
		editorDispatch: {
			kind,
			policy: definition.policy,
			ui: {
				surface: kind === "panel" ? "content-editor-panel" : "content-editor-action",
				locale,
				direction: getLocaleDir(locale),
				contentLocale: canonicalLocale ?? undefined,
				extensionId,
				entry: {
					collection,
					id: canonicalId,
					locale: canonicalLocale,
					version,
				},
			},
		},
	});
	if (!response.ok) return response;
	const envelope: unknown = await response.clone().json();
	if (!isRecord(envelope) || !isRecord(envelope.data)) {
		return apiError("INVALID_PLUGIN_RESPONSE", "Plugin returned an invalid response", 502);
	}
	const data = envelope.data;
	if (data.patch === undefined && !validatedDraft) return response;
	if (data.patch !== undefined && !validatedDraft) {
		return apiError(
			"EDITOR_DRAFT_INVALID",
			"Plugin returned an editor draft patch without a draft invocation",
			400,
		);
	}
	if (data.patch !== undefined) {
		const collectionSchema = await runtime.getPluginEditorDraftSchema(collection);
		if (!collectionSchema) return apiError("NOT_FOUND", "Collection not found", 404);
		const patch = validateEditorDraftPatch({
			patch: data.patch,
			collection: collectionSchema,
			allowedFields: validatedDraft?.patchFields ?? new Set(),
		});
		if ("code" in patch) {
			console.warn(
				`[plugin:${pluginId}] Editor draft ${kind}/${extensionId} rejected: ${patch.code}`,
			);
			return editorDraftErrorResponse(patch);
		}
		data.patch = patch;
	}
	const finalResponse = apiSuccess({ ...data, editorInvocation: validatedDraft?.receipt });
	finalResponse.headers.set("Cache-Control", "private, no-store");
	return finalResponse;
}
