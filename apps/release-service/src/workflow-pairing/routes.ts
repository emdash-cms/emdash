import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";
import { base64url, type JWTVerifyGetKey } from "jose";
import { ulid } from "ulidx";

import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import {
	WorkflowPairingError,
	type StoredWorkflowPairing,
} from "../publisher-do/workflow-pairing.js";
import {
	PublisherSessionError,
	requirePublisherApplicationSession,
} from "../publisher-session/session.js";
import { verifyGitHubActionsToken } from "../workload/github-oidc.js";
import { WorkloadIdentityError } from "../workload/types.js";

const PAIRING_PATH_PATTERN = /^\/v1\/publisher\/workflow-pairings\/([0-9A-HJKMNP-TV-Z]{26})$/;
const PAIRING_CONFIRM_PATH_PATTERN =
	/^\/v1\/publisher\/workflow-pairings\/([0-9A-HJKMNP-TV-Z]{26})\/confirm$/;
const PAIRING_CLAIM_PATH_PATTERN = /^\/v1\/workflow-pairings\/([0-9A-HJKMNP-TV-Z]{26})\/claim$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_LIFETIME_MS = 15 * 60_000;

export interface WorkflowPairingRouteDependencies {
	keyResolver?: JWTVerifyGetKey;
	now?: () => number;
	pairingId?: (now: number) => string;
	pairingToken?: () => string;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function pairingFailure(code: string, requestId: string): Response {
	if (code === "PAIRING_EXPIRED") {
		return apiFailure(new ApiError(code, 410, "Workflow connection expired"), requestId);
	}
	if (code === "PAIRING_LIMIT_REACHED") {
		return apiFailure(new ApiError(code, 429, "Too many pending workflow connections"), requestId);
	}
	if (code === "PAIRING_NOT_CLAIMED" || code === "PAIRING_CONFLICT") {
		return apiFailure(
			new ApiError(code, 409, "Workflow connection could not be confirmed"),
			requestId,
		);
	}
	return apiFailure(
		new ApiError("PAIRING_INVALID", 404, "Workflow connection not found"),
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
	if (error instanceof WorkflowPairingError) {
		return apiFailure(
			new ApiError("INVALID_REQUEST", 400, "Invalid workflow connection"),
			requestId,
		);
	}
	throw error;
}

function serializePairing(pairing: StoredWorkflowPairing) {
	return {
		id: pairing.id,
		packageSlug: pairing.packageSlug,
		state: pairing.state,
		claim: pairing.claim,
		expiresAt: pairing.expiresAt,
		createdAt: pairing.createdAt,
		claimedAt: pairing.claimedAt,
		confirmedAt: pairing.confirmedAt,
	};
}

function pairingId(params: Readonly<Record<string, string>>): string {
	const value = params["pairingId"];
	if (!value) throw new ApiError("PAIRING_INVALID", 404, "Workflow connection not found");
	return value;
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
	return value;
}

async function publisherSession(
	request: Request,
	configuration: ServiceConfiguration,
	requireCsrf = false,
) {
	return await requirePublisherApplicationSession(
		request,
		env.PUBLISHER_DO,
		configuration.publicOrigin,
		{ requireCsrf },
	);
}

export function matchWorkflowPairingPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = PAIRING_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { pairingId: match[1] } : null;
}

export function matchWorkflowPairingConfirmPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = PAIRING_CONFIRM_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { pairingId: match[1] } : null;
}

export function matchWorkflowPairingClaimPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = PAIRING_CLAIM_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { pairingId: match[1] } : null;
}

export async function handleCreateWorkflowPairing(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: WorkflowPairingRouteDependencies = {},
): Promise<Response> {
	try {
		const mutationKey = requireIdempotencyKey(request);
		const session = await publisherSession(request, configuration, true);
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["packageSlug"]) ||
			typeof body["packageSlug"] !== "string" ||
			!PACKAGE_SLUG_PATTERN.test(body["packageSlug"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Valid plugin package required");
		}
		const now = dependencies.now?.() ?? Date.now();
		const result = await env.PUBLISHER_DO.getByName(session.publisherDid).createWorkflowPairing({
			publisherDid: session.publisherDid,
			pairingId: dependencies.pairingId?.(now) ?? ulid(now),
			pairingToken:
				dependencies.pairingToken?.() ??
				base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
			mutationKey,
			packageSlug: body["packageSlug"],
			expiresAt: now + PAIRING_LIFETIME_MS,
			now,
		});
		if (!result.ok) return pairingFailure(result.code, requestId);
		return apiSuccess(
			{
				pairing: serializePairing(result.pairing),
				pairingToken: result.pairingToken,
				replayed: result.replayed,
			},
			requestId,
			result.replayed ? 200 : 201,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleGetWorkflowPairing(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	dependencies: WorkflowPairingRouteDependencies = {},
): Promise<Response> {
	try {
		const session = await publisherSession(request, configuration);
		const current = await env.PUBLISHER_DO.getByName(session.publisherDid).getWorkflowPairing(
			session.publisherDid,
			pairingId(params),
			dependencies.now?.() ?? Date.now(),
		);
		return current
			? apiSuccess({ pairing: serializePairing(current) }, requestId)
			: pairingFailure("PAIRING_INVALID", requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleClaimWorkflowPairing(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	dependencies: WorkflowPairingRouteDependencies = {},
): Promise<Response> {
	try {
		if (request.headers.has("cookie")) {
			throw new ApiError("AUTH_INVALID", 401, "GitHub authentication failed");
		}
		const authorization = request.headers.get("authorization");
		if (!authorization?.startsWith("Bearer ") || authorization.slice(7).includes(" ")) {
			throw new ApiError("AUTH_INVALID", 401, "GitHub authentication failed");
		}
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["publisherDid", "pairingToken"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"]) ||
			typeof body["pairingToken"] !== "string" ||
			!TOKEN_PATTERN.test(body["pairingToken"])
		) {
			throw new ApiError("PAIRING_INVALID", 404, "Workflow connection not found");
		}
		const identity = await verifyGitHubActionsToken(
			authorization.slice(7),
			configuration.publicOrigin,
			dependencies.keyResolver,
		);
		const result = await env.PUBLISHER_DO.getByName(body["publisherDid"]).claimWorkflowPairing({
			publisherDid: body["publisherDid"],
			pairingId: pairingId(params),
			pairingToken: body["pairingToken"],
			claim: {
				repository: identity.repository.name,
				repositoryId: identity.repository.id,
				repositoryOwner: identity.repository.owner,
				repositoryOwnerId: identity.repository.ownerId,
				repositoryVisibility: identity.repository.visibility,
				workflowRef: identity.workflow.ref,
				ref: identity.run.ref,
				environment: identity.run.environment,
			},
			now: dependencies.now?.() ?? Date.now(),
		});
		if (!result.ok) return pairingFailure(result.code, requestId);
		return apiSuccess(
			{ pairing: serializePairing(result.pairing), replayed: result.replayed },
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleConfirmWorkflowPairing(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	dependencies: WorkflowPairingRouteDependencies = {},
): Promise<Response> {
	try {
		requireIdempotencyKey(request);
		const session = await publisherSession(request, configuration, true);
		const body = await readJsonObject(request);
		if (!hasExactKeys(body, [])) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid workflow confirmation");
		}
		const result = await env.PUBLISHER_DO.getByName(session.publisherDid).confirmWorkflowPairing(
			session.publisherDid,
			pairingId(params),
			dependencies.now?.() ?? Date.now(),
		);
		if (!result.ok) return pairingFailure(result.code, requestId);
		return apiSuccess(
			{
				pairing: serializePairing(result.pairing),
				policy: result.policy,
				replayed: result.replayed,
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
