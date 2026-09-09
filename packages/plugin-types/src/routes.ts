import { z } from "zod";

export const routeOptionsSchema = z.object({
	/** Skip authentication and CSRF checks for this route. */
	public: z.boolean().optional(),
	/** RBAC permission required to invoke the route. */
	permission: z.string().optional(),
	/** Cache-Control for successful public GET/HEAD responses. */
	cacheControl: z.string().min(1).optional(),
});

export type RouteOptions = z.infer<typeof routeOptionsSchema>;

export const routeNameSchema = z
	.string()
	.min(1)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/, "Route name must be a safe path segment");

export const manifestRouteEntrySchema = routeOptionsSchema.extend({ name: routeNameSchema });

export type ManifestRouteEntry = z.infer<typeof manifestRouteEntrySchema>;

export function extractRouteOptions(route: unknown): RouteOptions {
	return routeOptionsSchema.parse(typeof route === "function" ? {} : route);
}

export function extractManifestRoute(name: string, route: unknown): ManifestRouteEntry | string {
	const options = extractRouteOptions(route);
	if (Object.values(options).every((value) => value === undefined)) return name;
	return { name, ...options };
}

export function normalizeManifestRoute(entry: string | ManifestRouteEntry): ManifestRouteEntry {
	return typeof entry === "string" ? { name: entry } : entry;
}
