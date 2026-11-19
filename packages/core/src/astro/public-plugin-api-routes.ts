import type { RouteMeta } from "../plugins/routes.js";
import type { PluginRouteResponse } from "./types.js";

export type PublicPluginApiRouteHandler = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
) => Promise<PluginRouteResponse>;

interface PublicPluginApiRouteRuntime {
	getPluginRouteMeta(pluginId: string, path: string): RouteMeta | null;
	handlePluginApiRoute(
		pluginId: string,
		method: string,
		path: string,
		request: Request,
	): Promise<PluginRouteResponse>;
}

export function getPublicPluginRouteMeta(
	runtime: Pick<PublicPluginApiRouteRuntime, "getPluginRouteMeta">,
	pluginId: string,
	path: string,
): RouteMeta | null {
	const meta = runtime.getPluginRouteMeta(pluginId, path);
	return meta?.public === true ? meta : null;
}

function pluginRouteNotFound(): PluginRouteResponse {
	return {
		success: false,
		error: {
			code: "NOT_FOUND",
			message: "Plugin route not found",
		},
	};
}

export function createPublicPluginApiRouteHandler(
	runtime: PublicPluginApiRouteRuntime,
): PublicPluginApiRouteHandler {
	return async (pluginId, method, path, request) => {
		if (!getPublicPluginRouteMeta(runtime, pluginId, path)) {
			return pluginRouteNotFound();
		}

		return runtime.handlePluginApiRoute(pluginId, method, path, request);
	};
}
