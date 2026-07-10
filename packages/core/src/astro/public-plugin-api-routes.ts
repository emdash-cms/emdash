import type { HandlerResponse } from "./types.js";

export type PublicPluginApiRouteHandler = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
) => Promise<HandlerResponse>;

interface PublicPluginApiRouteRuntime {
	getPluginRouteMeta(pluginId: string, path: string): { public: boolean } | null;
	handlePluginApiRoute(
		pluginId: string,
		method: string,
		path: string,
		request: Request,
	): Promise<HandlerResponse>;
}

function pluginRouteNotFound(): HandlerResponse {
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
		const meta = runtime.getPluginRouteMeta(pluginId, path);
		if (meta?.public !== true) {
			return pluginRouteNotFound();
		}

		return runtime.handlePluginApiRoute(pluginId, method, path, request);
	};
}
