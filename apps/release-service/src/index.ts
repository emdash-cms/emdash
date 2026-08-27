import type { JWTVerifyGetKey } from "jose";

import {
	accessRoleForOperatorPath,
	authenticateAccessRequest,
	validateAccessMutation,
	type AccessActor,
	type AccessRole,
} from "./access/auth.js";
import { ApiError } from "./api/errors.js";
import { getRequestId } from "./api/request-id.js";
import { apiFailure, apiSuccess } from "./api/response.js";
import {
	ConfigurationError,
	loadConfiguration,
	type ConfigurationBindings,
	type ServiceConfiguration,
} from "./config.js";
import { writeOperationsMetric } from "./observability/metrics.js";
import { ROUTES, type RouteDefinition } from "./routes.js";

export { PublisherDurableObject } from "./publisher-do/publisher-do.js";
export { ApproverDurableObject } from "./approver-do/approver-do.js";
export { OAuthStateDurableObject } from "./oauth/state-do.js";
export { ReleaseIntentWorkflow } from "./workflows/release-intent.js";
export { PublisherArchiveWorkflow } from "./workflows/publisher-archive.js";
export { EncryptionVerificationWorkflow } from "./workflows/encryption-verification.js";
export { ServiceControlDurableObject } from "./control-do/service-control-do.js";
export { IdentityDirectoryDurableObject } from "./directory/identity-directory-do.js";

const DYNAMIC_PATH_PREFIXES = ["/.well-known/", "/admin/api/", "/oauth/", "/v1/"] as const;

function isDynamicPath(pathname: string): boolean {
	return (
		pathname === "/health" ||
		pathname === "/ready" ||
		DYNAMIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
	);
}

async function authenticateOperatorUi(
	request: Request,
	configuration: ServiceConfiguration,
	keyResolver?: JWTVerifyGetKey,
): Promise<void> {
	let lastError: unknown;
	for (const role of ["admin", "reviewer", "viewer"] satisfies readonly AccessRole[]) {
		try {
			await authenticateAccessRequest(request, role, configuration.access, keyResolver);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

export async function handleUiRequest(
	request: Request,
	bindings: Env,
	accessKeyResolver?: JWTVerifyGetKey,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return apiFailure(
			new ApiError("METHOD_NOT_ALLOWED", 405, "Method not allowed"),
			getRequestId(request),
		);
	}
	if (new URL(request.url).pathname.startsWith("/admin")) {
		try {
			await authenticateOperatorUi(request, await loadConfiguration(bindings), accessKeyResolver);
		} catch (error) {
			if (error instanceof ApiError) {
				writeOperationsMetric({
					event: "access_denied",
					outcome: error.code,
					requestId: getRequestId(request),
				});
			}
			return apiFailure(error, getRequestId(request));
		}
	}
	const response = await bindings.ASSETS.fetch(request);
	const secured = new Response(response.body, response);
	secured.headers.set(
		"content-security-policy",
		"default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
	);
	secured.headers.set("referrer-policy", "no-referrer");
	secured.headers.set("x-content-type-options", "nosniff");
	secured.headers.set("x-frame-options", "DENY");
	if (secured.headers.get("content-type")?.startsWith("text/html")) {
		secured.headers.set("cache-control", "no-store");
	}
	return secured;
}

export async function handleRequest(
	request: Request,
	bindings: ConfigurationBindings,
	routes: readonly RouteDefinition[] = ROUTES,
	accessKeyResolver?: JWTVerifyGetKey,
): Promise<Response> {
	const requestId = getRequestId(request);
	try {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return request.method === "GET"
				? apiSuccess({ status: "ok" }, requestId)
				: apiFailure(new ApiError("METHOD_NOT_ALLOWED", 405, "Method not allowed"), requestId);
		}
		const configuration = await loadConfiguration(bindings);
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
			let accessActor: AccessActor | null = null;
			const operatorRole = accessRoleForOperatorPath(url.pathname);
			if (
				(url.pathname.startsWith("/admin/api/") && route.candidate.accessRole === undefined) ||
				(operatorRole !== null && operatorRole !== route.candidate.accessRole) ||
				(!url.pathname.startsWith("/admin/api/") && route.candidate.accessRole !== undefined)
			) {
				throw new Error("Operator route has an invalid Access role boundary");
			}
			if (route.candidate.accessRole) {
				accessActor = await authenticateAccessRequest(
					request,
					route.candidate.accessRole,
					configuration.access,
					accessKeyResolver,
				);
				if (route.candidate.method !== "GET") {
					validateAccessMutation(request, configuration.publicOrigin);
				}
			}
			return await route.candidate.handler(
				request,
				requestId,
				configuration,
				route.params,
				accessActor,
			);
		}
		if (matches.length > 0) {
			return apiFailure(new ApiError("METHOD_NOT_ALLOWED", 405, "Method not allowed"), requestId);
		}
		return apiFailure(new ApiError("NOT_FOUND", 404, "Not found"), requestId);
	} catch (error) {
		if (error instanceof ConfigurationError) {
			writeOperationsMetric({
				event: "configuration_failure",
				outcome: "invalid",
				requestId,
			});
			console.error(JSON.stringify({ event: "configuration_error", issues: error.issues }));
			return apiFailure(
				new ApiError("CONFIGURATION_ERROR", 503, "Service is not configured"),
				requestId,
			);
		}
		if (
			error instanceof ApiError &&
			(error.code === "ACCESS_AUTH_INVALID" ||
				error.code === "ACCESS_AUTH_REQUIRED" ||
				error.code === "ACCESS_DENIED")
		) {
			writeOperationsMetric({
				event: "access_denied",
				outcome: error.code,
				requestId,
			});
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
		return isDynamicPath(new URL(request.url).pathname)
			? handleRequest(request, env)
			: handleUiRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
