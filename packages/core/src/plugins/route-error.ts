/**
 * Error class for plugin routes
 * Allows plugins to return structured errors with specific HTTP status codes
 */
export class PluginRouteError extends Error {
	constructor(
		public code: string,
		message: string,
		public status: number = 400,
		public details?: unknown,
	) {
		super(message);
		this.name = "PluginRouteError";
	}

	/**
	 * Create a bad request error (400)
	 */
	static badRequest(message: string, details?: unknown): PluginRouteError {
		return new PluginRouteError("BAD_REQUEST", message, 400, details);
	}

	/**
	 * Create an unauthorized error (401)
	 */
	static unauthorized(message: string = "Unauthorized"): PluginRouteError {
		return new PluginRouteError("UNAUTHORIZED", message, 401);
	}

	/**
	 * Create a forbidden error (403)
	 */
	static forbidden(message: string = "Forbidden"): PluginRouteError {
		return new PluginRouteError("FORBIDDEN", message, 403);
	}

	/**
	 * Create a not found error (404)
	 */
	static notFound(message: string = "Not found"): PluginRouteError {
		return new PluginRouteError("NOT_FOUND", message, 404);
	}

	/**
	 * Create a conflict error (409)
	 */
	static conflict(message: string, details?: unknown): PluginRouteError {
		return new PluginRouteError("CONFLICT", message, 409, details);
	}

	/**
	 * Create an internal error (500)
	 */
	static internal(message: string = "Internal error"): PluginRouteError {
		return new PluginRouteError("INTERNAL_ERROR", message, 500);
	}
}

/**
 * Check whether a thrown value is a PluginRouteError.
 *
 * Also matches on shape, not just `instanceof`: under `astro dev`, Vite can load a
 * plugin's `emdash` import as a separate module instance, so the error the plugin
 * throws comes from a different copy of this class.
 */
export function isPluginRouteError(error: unknown): error is PluginRouteError {
	if (error instanceof PluginRouteError) return true;
	if (!(error instanceof Error) || error.name !== "PluginRouteError") return false;
	const { code, status } = error as Partial<PluginRouteError>;
	return typeof code === "string" && typeof status === "number";
}
