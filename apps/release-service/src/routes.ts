import { apiSuccess } from "./api/response.js";
import type { ServiceConfiguration } from "./config.js";
import { getClientMetadata, getPublicJwks, publicOAuthJson } from "./oauth/metadata.js";

export interface RouteDefinition {
	method: "GET" | "POST";
	path: string;
	handler(
		request: Request,
		requestId: string,
		configuration: ServiceConfiguration,
	): Response | Promise<Response>;
}

export const ROUTES = Object.freeze([
	{
		method: "GET",
		path: "/.well-known/atproto-client-metadata.json",
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getClientMetadata(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/oauth/jwks.json",
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getPublicJwks(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/health",
		handler: (_request, requestId) => apiSuccess({ status: "ok" }, requestId),
	},
] as const satisfies readonly RouteDefinition[]);
