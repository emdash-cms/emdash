import { getLocaleDir, resolveLocale } from "@emdash-cms/admin/locales";
import { Permissions, type Permission, type RoleLevel } from "@emdash-cms/auth";
import { validateContentEditorPanelInteraction } from "@emdash-cms/blocks/server";

import { requirePerm, requireOwnerPerm } from "../api/authorize.js";
import { apiError, apiSuccess } from "../api/error.js";
import { requireScope } from "../auth/scopes.js";
import type { EmDashRuntime, PluginEditorExtensionDispatch } from "../emdash-runtime.js";
import type { UserInfo } from "./types.js";

function toRoleLevel(value: number): RoleLevel | null {
	if (value === 10 || value === 20 || value === 30 || value === 40 || value === 50) {
		return value;
	}
	return null;
}

function isPermission(value: string): value is Permission {
	return value in Permissions;
}

export interface PluginApiRequestContext {
	runtime: EmDashRuntime;
	pluginId: string;
	path: string;
	request: Request;
	user?: UserInfo | null;
	tokenScopes?: string[];
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
	editorDispatch,
}: PluginApiRequestContext): Promise<Response> {
	const method = request.method.toUpperCase();
	const routeMeta = runtime.getPluginRouteMeta(pluginId, path);
	if (!routeMeta) return apiError("NOT_FOUND", "Plugin route not found", 404);

	if (!routeMeta.public) {
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
	}

	const caller = routeMeta.public ? undefined : (user ?? undefined);
	const result = await runtime.handlePluginApiRoute(
		pluginId,
		method,
		path,
		request,
		caller,
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

	const response = apiSuccess(result.data);
	if (routeMeta.cacheControl && (method === "GET" || method === "HEAD")) {
		response.headers.set("Cache-Control", routeMeta.cacheControl);
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
}

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
	if (!canonicalId || version === null) {
		return apiError("CONTENT_GET_ERROR", "Content item has invalid identity", 500);
	}

	let input: unknown;
	if (kind === "panel") {
		try {
			input = await request.json();
		} catch {
			return apiError("INVALID_REQUEST", "Editor panel interaction must be JSON", 400);
		}
		const validation = validateContentEditorPanelInteraction(input);
		if (!validation.valid) {
			return apiError("INVALID_PLUGIN_UI_CONTEXT", "Invalid editor panel interaction", 400);
		}
	} else {
		input = { type: "editor_action" };
	}

	const headers = new Headers(request.headers);
	headers.set("Content-Type", "application/json");
	const pluginRequest = new Request(request.url, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	const locale = resolveLocale(request);
	return dispatchPluginApiRequest({
		runtime,
		pluginId,
		path: definition.extension.route,
		request: pluginRequest,
		user,
		tokenScopes,
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
}
