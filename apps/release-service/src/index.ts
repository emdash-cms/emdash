import { ApiError } from "./api/errors.js";
import { getRequestId } from "./api/request-id.js";
import { apiFailure } from "./api/response.js";
import { ConfigurationError, loadConfiguration, type ConfigurationBindings } from "./config.js";
import { ROUTES, type RouteDefinition } from "./routes.js";

export { PublisherDurableObject } from "./publisher-do/publisher-do.js";
export { ApproverDurableObject } from "./approver-do/approver-do.js";
export { ReleaseIntentWorkflow } from "./workflows/release-intent.js";

export async function handleRequest(
	request: Request,
	bindings: ConfigurationBindings,
	routes: readonly RouteDefinition[] = ROUTES,
): Promise<Response> {
	const requestId = getRequestId(request);
	try {
		const configuration = await loadConfiguration(bindings);
		const url = new URL(request.url);
		const matches = routes.flatMap((candidate) => {
			const params = candidate.match
				? candidate.match(url.pathname)
				: candidate.path === url.pathname
					? {}
					: null;
			return params === null ? [] : [{ candidate, params }];
		});
		const route = matches.find(({ candidate }) => candidate.method === request.method);
		if (route) {
			return await route.candidate.handler(request, requestId, configuration, route.params);
		}
		if (matches.length > 0) {
			return apiFailure(new ApiError("METHOD_NOT_ALLOWED", 405, "Method not allowed"), requestId);
		}
		return apiFailure(new ApiError("NOT_FOUND", 404, "Not found"), requestId);
	} catch (error) {
		if (error instanceof ConfigurationError) {
			console.error(JSON.stringify({ event: "configuration_error", issues: error.issues }));
			return apiFailure(
				new ApiError("CONFIGURATION_ERROR", 503, "Service is not configured"),
				requestId,
			);
		}
		console.error(
			JSON.stringify({
				event: "request_error",
				requestId,
				error:
					error instanceof ApiError
						? { name: "ApiError", code: error.code }
						: { name: "UnhandledError" },
			}),
		);
		return apiFailure(error, requestId);
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
