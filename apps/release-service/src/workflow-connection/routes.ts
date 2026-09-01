import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";
import { base64url, type JWTVerifyGetKey } from "jose";
import { ulid } from "ulidx";

import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import {
	WorkflowConnectionError,
	type StoredWorkflowConnectionRequest,
} from "../publisher-do/workflow-connection.js";
import {
	PublisherSessionError,
	requirePublisherApplicationSession,
} from "../publisher-session/session.js";
import { verifyGitHubActionsToken } from "../workload/github-oidc.js";
import { WorkloadIdentityError } from "../workload/types.js";

const CONFIRM_PATH_PATTERN =
	/^\/v1\/publisher\/workflow-connections\/([0-9A-HJKMNP-TV-Z]{26})\/confirm$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REQUEST_LIFETIME_MS = 30 * 60_000;
const MAX_AUTHORIZATION_CHARS = 16 * 1024;

export interface WorkflowConnectionRouteDependencies {
	keyResolver?: JWTVerifyGetKey;
	now?: () => number;
	requestId?: (now: number) => string;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

async function digest(value: unknown): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
		),
	);
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
	return value;
}

function requireBearerToken(request: Request): string {
	const value = request.headers.get("authorization");
	if (
		!value ||
		value.length > MAX_AUTHORIZATION_CHARS ||
		!value.startsWith("Bearer ") ||
		value.slice(7).length === 0 ||
		value.slice(7).includes(" ") ||
		request.headers.has("cookie")
	) {
		throw new ApiError("AUTH_INVALID", 401, "GitHub authentication failed");
	}
	return value.slice(7);
}

function serializeRequest(request: StoredWorkflowConnectionRequest) {
	return {
		id: request.id,
		packageSlug: request.packageSlug,
		state: request.state,
		claim: request.claim,
		refScope: request.refScope,
		expiresAt: request.expiresAt,
		createdAt: request.createdAt,
		confirmedAt: request.confirmedAt,
	};
}

function connectionFailure(code: string, requestId: string): Response {
	if (code === "DELEGATION_REQUIRED") {
		return apiFailure(
			new ApiError(code, 409, "Authorize publishing before connecting a workflow"),
			requestId,
		);
	}
	if (code === "PUBLISHER_SUSPENDED") {
		return apiFailure(new ApiError(code, 403, "Publisher is suspended"), requestId);
	}
	if (code === "WORKFLOW_CONNECTION_LIMIT_REACHED") {
		return apiFailure(new ApiError(code, 429, "Too many pending workflow connections"), requestId);
	}
	if (code === "WORKFLOW_CONNECTION_EXPIRED") {
		return apiFailure(new ApiError(code, 410, "Workflow connection expired"), requestId);
	}
	if (code === "WORKFLOW_CONNECTION_CONFLICT") {
		return apiFailure(
			new ApiError(code, 409, "Workflow connection could not be confirmed"),
			requestId,
		);
	}
	return apiFailure(
		new ApiError("WORKFLOW_CONNECTION_NOT_FOUND", 404, "Workflow connection not found"),
		requestId,
	);
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	if (error instanceof PublisherSessionError) {
		const suspended = error.code === "PUBLISHER_SUSPENDED";
		return apiFailure(
			new ApiError(
				suspended ? "PUBLISHER_SUSPENDED" : "PUBLISHER_SESSION_INVALID",
				suspended ? 403 : 401,
				suspended ? "Account is suspended" : "Account session is not valid",
			),
			requestId,
		);
	}
	if (error instanceof WorkloadIdentityError) {
		return apiFailure(new ApiError("AUTH_INVALID", 401, "GitHub authentication failed"), requestId);
	}
	if (error instanceof WorkflowConnectionError) {
		return apiFailure(
			new ApiError("INVALID_REQUEST", 400, "Invalid workflow connection"),
			requestId,
		);
	}
	throw error;
}

function connectionRequestId(params: Readonly<Record<string, string>>): string {
	const value = params["requestId"];
	if (!value)
		throw new ApiError("WORKFLOW_CONNECTION_NOT_FOUND", 404, "Workflow connection not found");
	return value;
}

async function publisherSession(request: Request, configuration: ServiceConfiguration) {
	return await requirePublisherApplicationSession(
		request,
		env.PUBLISHER_DO,
		configuration.publicOrigin,
	);
}

export function matchWorkflowConnectionConfirmPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = CONFIRM_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { requestId: match[1] } : null;
}

export async function handleRequestWorkflowConnection(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: WorkflowConnectionRouteDependencies = {},
): Promise<Response> {
	try {
		const mutationKey = requireIdempotencyKey(request);
		const identity = await verifyGitHubActionsToken(
			requireBearerToken(request),
			configuration.publicOrigin,
			dependencies.keyResolver,
		);
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["publisherDid", "packageSlug"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"]) ||
			typeof body["packageSlug"] !== "string" ||
			!PACKAGE_SLUG_PATTERN.test(body["packageSlug"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Valid publisher and plugin package required");
		}
		const claim = {
			repository: identity.repository.name,
			repositoryId: identity.repository.id,
			repositoryOwner: identity.repository.owner,
			repositoryOwnerId: identity.repository.ownerId,
			repositoryVisibility: identity.repository.visibility,
			workflowRef: identity.workflow.ref,
			ref: identity.run.ref,
			environment: identity.run.environment,
		};
		const publisherDid = body["publisherDid"];
		const packageSlug = body["packageSlug"];
		const now = dependencies.now?.() ?? Date.now();
		const result = await env.PUBLISHER_DO.getByName(publisherDid).requestWorkflowConnection({
			publisherDid,
			requestId: dependencies.requestId?.(now) ?? ulid(now),
			mutationKey,
			connectionKey: await digest([
				"workflow-connection",
				1,
				publisherDid,
				packageSlug,
				claim.repositoryId,
				claim.repositoryOwnerId,
				claim.workflowRef,
				claim.ref,
				claim.environment,
			]),
			packageSlug,
			claim,
			expiresAt: now + REQUEST_LIFETIME_MS,
			now,
		});
		if (!result.ok) return connectionFailure(result.code, requestId);
		if (result.status === "connected") {
			return apiSuccess({ status: "connected", policy: result.policy }, requestId);
		}
		return apiSuccess(
			{
				status: "pending",
				request: serializeRequest(result.request),
				approvalUrl: `${configuration.publicOrigin}/publisher?connection=${result.request.id}`,
				replayed: result.replayed,
			},
			requestId,
			202,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleListWorkflowConnections(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: Pick<WorkflowConnectionRouteDependencies, "now"> = {},
): Promise<Response> {
	try {
		const session = await publisherSession(request, configuration);
		const items = await env.PUBLISHER_DO.getByName(
			session.publisherDid,
		).listWorkflowConnectionRequests(session.publisherDid, 20, dependencies.now?.() ?? Date.now());
		return apiSuccess({ items: items.map(serializeRequest) }, requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleConfirmWorkflowConnection(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	dependencies: Pick<WorkflowConnectionRouteDependencies, "now"> = {},
): Promise<Response> {
	try {
		requireIdempotencyKey(request);
		const session = await requirePublisherApplicationSession(
			request,
			env.PUBLISHER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["refScope"]) ||
			(body["refScope"] !== "current_ref" && body["refScope"] !== "version_tags")
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Valid workflow release scope required");
		}
		const result = await env.PUBLISHER_DO.getByName(session.publisherDid).confirmWorkflowConnection(
			session.publisherDid,
			connectionRequestId(params),
			body["refScope"],
			dependencies.now?.() ?? Date.now(),
		);
		if (!result.ok) return connectionFailure(result.code, requestId);
		return apiSuccess(
			{
				request: serializeRequest(result.request),
				policy: result.policy,
				replayed: result.replayed,
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
