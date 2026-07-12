import { apiSuccess } from "./api/response.js";
import type { ServiceConfiguration } from "./config.js";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDefinition {
	method: RouteMethod;
	path: string;
	operationId: string;
	summary: string;
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
