import { apiSuccess } from "./api/response.js";
import type { ServiceConfiguration } from "./config.js";
import { getClientMetadata, getPublicJwks, publicOAuthJson } from "./oauth/metadata.js";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDefinition {
	method: RouteMethod;
	path: string;
	operationId: string;
	summary: string;
	includeInApiSchema?: boolean;
	successStatus: number;
	successDataSchema: Readonly<Record<string, unknown>>;
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
		operationId: "getAtprotoClientMetadata",
		summary: "Get atproto OAuth client metadata",
		includeInApiSchema: false,
		successStatus: 200,
		successDataSchema: { type: "object" },
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getClientMetadata(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/oauth/jwks.json",
		operationId: "getAtprotoClientJwks",
		summary: "Get atproto OAuth client assertion keys",
		includeInApiSchema: false,
		successStatus: 200,
		successDataSchema: { type: "object" },
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getPublicJwks(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/health",
		operationId: "getHealth",
		summary: "Check release-service health",
		successStatus: 200,
		successDataSchema: {
			type: "object",
			required: ["status"],
			additionalProperties: false,
			properties: { status: { const: "ok" } },
		},
		handler: (_request, requestId) => apiSuccess({ status: "ok" }, requestId),
	},
] as const satisfies readonly RouteDefinition[]);
