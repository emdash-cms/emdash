import { ROUTES } from "../routes.js";
import type { RouteDefinition } from "../routes.js";
import { API_ERROR_CODES } from "./errors.js";

const requestIdSchema = {
	type: "string",
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
} as const;

const errorEnvelopeSchema = {
	type: "object",
	required: ["error", "requestId"],
	additionalProperties: false,
	properties: {
		error: {
			type: "object",
			required: ["code", "message"],
			additionalProperties: false,
			properties: {
				code: { type: "string", enum: API_ERROR_CODES },
				message: { type: "string" },
				details: {},
			},
		},
		requestId: requestIdSchema,
	},
} as const;

export function generateApiSchema(routes: readonly RouteDefinition[] = ROUTES) {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const route of routes) {
		if (route.includeInApiSchema === false) continue;
		const path = (paths[route.path] ??= {});
		path[route.method.toLowerCase()] = {
			operationId: route.operationId,
			summary: route.summary,
			responses: {
				[route.successStatus]: {
					description: "Successful response",
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["data", "requestId"],
								additionalProperties: false,
								properties: {
									data: route.successDataSchema,
									requestId: requestIdSchema,
								},
							},
						},
					},
				},
				default: {
					description: "Error response",
					content: { "application/json": { schema: errorEnvelopeSchema } },
				},
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: { title: "EmDash Delegated Release Service API", version: "1.0.0" },
		paths,
	};
}
