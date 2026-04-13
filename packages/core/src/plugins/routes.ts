/**
 * Plugin Routes v2
 *
 * Handles plugin API route invocation with:
 * - Input validation via Zod schemas
 * - Route context creation
 * - Error handling
 *
 */

import { PluginContextFactory, type PluginContextFactoryOptions } from "./context.js";
import { extractRequestMeta } from "./request-meta.js";
import type { ResolvedPlugin, RouteContext, PluginRoute } from "./types.js";

/**
 * Route metadata (public flag) without the handler.
 * Used by the catch-all route to decide auth before dispatch.
 */
export interface RouteMeta {
	public: boolean;
}

/**
 * Result from a route invocation
 */
export interface RouteResult<T = unknown> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
	status: number;
}

/**
 * Route invocation options
 */
export interface InvokeRouteOptions {
	/** The original request */
	request: Request;
	/** Request body (already parsed) */
	body?: unknown;
}

/**
 * Route handler for a plugin
 */
export class PluginRouteHandler {
	private contextFactory: PluginContextFactory;
	private plugin: ResolvedPlugin;

	constructor(plugin: ResolvedPlugin, factoryOptions: PluginContextFactoryOptions) {
		this.plugin = plugin;
		this.contextFactory = new PluginContextFactory(factoryOptions);
	}

	/**
	 * Invoke a route by name
	 */
	async invoke(routeName: string, options: InvokeRouteOptions): Promise<RouteResult> {
		const route = this.plugin.routes[routeName];

		if (!route) {
			return {
				success: false,
				error: {
					code: "ROUTE_NOT_FOUND",
					message: `Route "${routeName}" not found in plugin "${this.plugin.id}"`,
				},
				status: 404,
			};
		}

		// Validate input if schema is provided
		let validatedInput: unknown;
		if (route.input) {
			const parseResult = route.input.safeParse(options.body);
			if (!parseResult.success) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: "Invalid request body",
						details: parseResult.error.format(),
					},
					status: 400,
				};
			}
			validatedInput = parseResult.data;
		} else {
			validatedInput = options.body;
		}

		// Create route context
		const baseContext = this.contextFactory.createContext(this.plugin);
		const routeContext: RouteContext = {
			...baseContext,
			input: validatedInput,
			request: options.request,
			requestMeta: extractRequestMeta(options.request),
		};

		// Execute handler
		try {
			const result = await route.handler(routeContext);
			return {
				success: true,
				data: result,
				status: 200,
			};
		} catch (error) {
			// Handle known error types
			if (error instanceof PluginRouteError) {
				return {
					success: false,
					error: {
						code: error.code,
						message: error.message,
						details: error.details,
					},
					status: error.status,
				};
			}

			// Unknown error -- log internally, return generic message
			console.error(`[plugin:${this.plugin.id}] Route handler failed:`, error);
			return {
				success: false,
				error: {
					code: "INTERNAL_ERROR",
					message: "An internal error occurred",
				},
				status: 500,
			};
		}
	}

	/**
	 * Get all route names
	 */
	getRouteNames(): string[] {
		return Object.keys(this.plugin.routes);
	}

	/**
	 * Check if a route exists
	 */
	hasRoute(name: string): boolean {
		return name in this.plugin.routes;
	}

	/**
	 * Get route metadata without invoking the handler.
	 * Returns null if the route doesn't exist.
	 */
	getRouteMeta(name: string): RouteMeta | null {
		const route: PluginRoute | undefined = this.plugin.routes[name];
		if (!route) return null;
		return { public: route.public === true };
	}
}

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
 * Registry for all plugin route handlers
 */
export class PluginRouteRegistry {
	private handlers: Map<string, PluginRouteHandler> = new Map();

	constructor(private factoryOptions: PluginContextFactoryOptions) {}

	/**
	 * Register a plugin's routes
	 */
	register(plugin: ResolvedPlugin): void {
		const handler = new PluginRouteHandler(plugin, this.factoryOptions);
		this.handlers.set(plugin.id, handler);
	}

	/**
	 * Unregister a plugin's routes
	 */
	unregister(pluginId: string): void {
		this.handlers.delete(pluginId);
	}

	/**
	 * Invoke a plugin route
	 */
	async invoke(
		pluginId: string,
		routeName: string,
		options: InvokeRouteOptions,
	): Promise<RouteResult> {
		const handler = this.handlers.get(pluginId);

		if (!handler) {
			return {
				success: false,
				error: {
					code: "PLUGIN_NOT_FOUND",
					message: `Plugin "${pluginId}" not found`,
				},
				status: 404,
			};
		}

		return handler.invoke(routeName, options);
	}

	/**
	 * Get all registered plugin IDs
	 */
	getPluginIds(): string[] {
		return [...this.handlers.keys()];
	}

	/**
	 * Get routes for a plugin
	 */
	getRoutes(pluginId: string): string[] {
		return this.handlers.get(pluginId)?.getRouteNames() ?? [];
	}

	/**
	 * Get route metadata for a specific plugin route.
	 * Returns null if the plugin or route doesn't exist.
	 */
	getRouteMeta(pluginId: string, routeName: string): RouteMeta | null {
		const handler = this.handlers.get(pluginId);
		if (!handler) return null;
		return handler.getRouteMeta(routeName);
	}
}

/**
 * Create a route registry
 */
export function createRouteRegistry(
	factoryOptions: PluginContextFactoryOptions,
): PluginRouteRegistry {
	return new PluginRouteRegistry(factoryOptions);
}
