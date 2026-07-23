export class PluginRouteError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
	}

	static notFound(message: string) {
		return new PluginRouteError("NOT_FOUND", message, 404);
	}

	static forbidden(message: string) {
		return new PluginRouteError("FORBIDDEN", message, 403);
	}

	static internal(message: string) {
		return new PluginRouteError("INTERNAL_ERROR", message, 500);
	}

	static badRequest(message: string) {
		return new PluginRouteError("BAD_REQUEST", message, 400);
	}
}

export function definePlugin<T>(plugin: T): T {
	return plugin;
}
