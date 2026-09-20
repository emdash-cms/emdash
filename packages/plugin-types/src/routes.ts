import { z } from "zod";

export const PLUGIN_ROUTE_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PLUGIN_ROUTE_DEFAULT_BODY_BYTES = 1024 * 1024;
export const PLUGIN_ROUTE_MAX_MULTIPART_PARTS = 100;
export const PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES = 1024 * 1024;
export const PLUGIN_ROUTE_MAX_FILENAME_BYTES = 255;
export const PLUGIN_ROUTE_MAX_DECLARED_HEADERS = 32;

export const PLUGIN_ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export const PLUGIN_ROUTE_BODY_MODES = ["none", "json", "text", "bytes", "form-data"] as const;
export const PLUGIN_ROUTE_RESPONSE_MODES = ["json", "raw"] as const;

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_REQUEST_HEADERS = new Set([
	"authorization",
	"cookie",
	"cf-access-client-id",
	"cf-access-client-secret",
	"cf-access-jwt-assertion",
	"proxy-authorization",
	"set-cookie",
	"x-emdash-request",
]);

const declaredHeadersSchema = z
	.array(z.string().min(1).max(128).regex(HEADER_NAME_PATTERN, "Invalid HTTP header name"))
	.max(PLUGIN_ROUTE_MAX_DECLARED_HEADERS)
	.superRefine((headers, ctx) => {
		const seen = new Set<string>();
		for (const [index, header] of headers.entries()) {
			const normalized = header.toLowerCase();
			if (FORBIDDEN_REQUEST_HEADERS.has(normalized) || normalized.startsWith("cf-access-")) {
				ctx.addIssue({
					code: "custom",
					message: `Header "${header}" cannot be exposed to a sandboxed route`,
					path: [index],
				});
			}
			if (seen.has(normalized)) {
				ctx.addIssue({
					code: "custom",
					message: `Header "${header}" is declared more than once`,
					path: [index],
				});
			}
			seen.add(normalized);
		}
	});

export const pluginRouteRequestSchema = z
	.object({
		body: z.enum(PLUGIN_ROUTE_BODY_MODES),
		maxBytes: z.number().int().positive().max(PLUGIN_ROUTE_MAX_BODY_BYTES).optional(),
		headers: declaredHeadersSchema.optional(),
	})
	.superRefine((request, ctx) => {
		if (request.body === "none" && request.maxBytes !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "maxBytes cannot be set when request.body is none",
				path: ["maxBytes"],
			});
		}
	});

export const routeOptionsSchema = z
	.object({
		methods: z
			.array(z.enum(PLUGIN_ROUTE_METHODS))
			.min(1)
			.max(PLUGIN_ROUTE_METHODS.length)
			.optional(),
		request: pluginRouteRequestSchema.optional(),
		response: z.enum(PLUGIN_ROUTE_RESPONSE_MODES).optional(),
		public: z.boolean().optional(),
		permission: z.string().min(1).optional(),
		cacheControl: z.string().min(1).optional(),
	})
	.superRefine((route, ctx) => {
		if (route.methods && new Set(route.methods).size !== route.methods.length) {
			ctx.addIssue({ code: "custom", message: "Route methods must not contain duplicates" });
		}
	});

export type PluginRouteMethod = (typeof PLUGIN_ROUTE_METHODS)[number];
export type PluginRouteBodyMode = (typeof PLUGIN_ROUTE_BODY_MODES)[number];
export type PluginRouteResponseMode = (typeof PLUGIN_ROUTE_RESPONSE_MODES)[number];
export type PluginRouteRequest = z.infer<typeof pluginRouteRequestSchema>;
export type RouteOptions = z.infer<typeof routeOptionsSchema>;

export type PluginRouteQuery = Record<string, string | string[]>;

export interface PluginFormDataTextEntry {
	name: string;
	kind: "text";
	value: string;
}

export interface PluginFormDataFileEntry {
	name: string;
	kind: "file";
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export interface PluginFormData {
	entries: Array<PluginFormDataTextEntry | PluginFormDataFileEntry>;
}

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

export function isJsonPostRouteContract(
	route: Pick<RouteOptions, "methods" | "request" | "response">,
): boolean {
	return (
		route.response !== "raw" &&
		(route.methods === undefined || route.methods.includes("POST")) &&
		(route.request === undefined || route.request.body === "json")
	);
}
