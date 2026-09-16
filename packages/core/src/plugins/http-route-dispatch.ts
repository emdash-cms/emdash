import { Permissions, type Permission, type RoleLevel } from "@emdash-cms/auth";

import { requirePerm } from "../api/authorize.js";
import { apiError, apiSuccess } from "../api/error.js";
import { requireScope } from "../auth/scopes.js";
import type { EmDashRuntime } from "../emdash-runtime.js";
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
}

/** Dispatch a request through the production plugin-route policy boundary. */
export async function dispatchPluginApiRequest({
	runtime,
	pluginId,
	path,
	request,
	user,
	tokenScopes,
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
	const result = await runtime.handlePluginApiRoute(pluginId, method, path, request, caller);
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
