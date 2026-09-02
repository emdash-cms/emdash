import { isDid } from "@atcute/lexicons/syntax";
import { parseDelegatedReleaseSourceRecord } from "@emdash-cms/registry-client/release-service";
import { env } from "cloudflare:workers";
import { base64url, type JWTVerifyGetKey } from "jose";
import { ulid } from "ulidx";

import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import { decodeAwaitingApprovalState } from "../approvals/digest.js";
import { invalidateApprovalChallenges } from "../approvals/invalidation.js";
import type { ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../control-do/service-control-do.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import type { IntentState, StoredIntent } from "../publisher-do/publisher-do.js";
import {
	PublisherSessionError,
	requirePublisherApplicationSession,
} from "../publisher-session/session.js";
import { startReleaseIntentWorkflow } from "../workflows/start.js";
import { verifyGitHubActionsToken } from "../workload/github-oidc.js";
import {
	digestWorkloadIdempotencyIdentity,
	digestWorkloadIdentity,
	evaluateWorkloadPolicy,
} from "../workload/policy.js";
import { WorkloadIdentityError, type VerifiedWorkloadIdentity } from "../workload/types.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const INTENT_RESOURCE_PATH_PATTERN = /^\/v1\/release-intents\/([0-9A-HJKMNP-TV-Z]{26})$/;
const INTENT_CANCEL_PATH_PATTERN = /^\/v1\/release-intents\/([0-9A-HJKMNP-TV-Z]{26})\/cancel$/;
const MAX_AUTHORIZATION_CHARS = 16 * 1024;
const MAX_INTENT_BODY_BYTES = 128 * 1024;
const MAX_RELEASE_INPUT_CHARS = 64 * 1024;
const INTENT_LIFETIME_MS = 24 * 60 * 60_000;
const CANCELLABLE_STATES: ReadonlySet<IntentState> = new Set([
	"received",
	"verifying",
	"verified",
	"awaiting_approval",
	"ready",
]);

interface IntentActor {
	realm: "oidc" | "publisher";
	identity: string;
	publisherDid: string;
}

export interface SubmitIntentDependencies {
	keyResolver?: JWTVerifyGetKey;
	now?: () => number;
	intentId?: (now: number) => string;
	startWorkflow?: typeof startReleaseIntentWorkflow;
}

export interface DryRunIntentDependencies {
	keyResolver?: JWTVerifyGetKey;
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
		throw new ApiError("AUTH_INVALID", 401, "Workload authentication failed");
	}
	return value.slice(7);
}

async function authenticateWorkload(
	request: Request,
	configuration: ServiceConfiguration,
	keyResolver?: JWTVerifyGetKey,
): Promise<VerifiedWorkloadIdentity> {
	try {
		return await verifyGitHubActionsToken(
			requireBearerToken(request),
			configuration.publicOrigin,
			keyResolver,
		);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError("AUTH_INVALID", 401, "Workload authentication failed");
	}
}

function requirePublisherQuery(request: Request): string {
	const publisherDid = new URL(request.url).searchParams.get("publisher");
	if (!publisherDid || !isDid(publisherDid)) {
		throw new ApiError("INVALID_REQUEST", 400, "Valid publisher DID required");
	}
	return publisherDid;
}

function mapPublisherSessionError(error: PublisherSessionError): ApiError {
	if (error.code === "PUBLISHER_SUSPENDED") {
		return new ApiError("PUBLISHER_SUSPENDED", 403, "Publisher is suspended");
	}
	if (error.code === "CSRF_INVALID" || error.code === "ORIGIN_INVALID") {
		return new ApiError("CSRF_INVALID", 403, "Request origin could not be verified");
	}
	return new ApiError("PUBLISHER_SESSION_INVALID", 401, "Publisher session is not valid");
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	if (error instanceof PublisherSessionError) {
		return apiFailure(mapPublisherSessionError(error), requestId);
	}
	if (error instanceof WorkloadIdentityError) {
		return apiFailure(
			new ApiError("AUTH_INVALID", 401, "Workload authentication failed"),
			requestId,
		);
	}
	throw error;
}

function parseResult(stateDataJson: string): { uri: string; cid: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stateDataJson);
	} catch {
		return null;
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("resultUri" in parsed) ||
		typeof parsed.resultUri !== "string" ||
		!("resultCid" in parsed) ||
		typeof parsed.resultCid !== "string"
	) {
		return null;
	}
	return { uri: parsed.resultUri, cid: parsed.resultCid };
}

export async function serializeIntentResource(
	publisherDid: string,
	intent: StoredIntent,
	publicOrigin: string,
): Promise<Record<string, unknown>> {
	const transitions = await env.PUBLISHER_DO.getByName(publisherDid).listIntentTransitions(
		publisherDid,
		intent.id,
	);
	const latest = transitions.at(-1);
	const result = parseResult(intent.stateDataJson);
	return {
		id: intent.id,
		publisherDid,
		packageSlug: intent.packageSlug,
		version: intent.version,
		state: intent.state,
		stateGeneration: intent.stateGeneration,
		reasonCode: latest?.reasonCode ?? null,
		workflowId: intent.workflowId,
		expiresAt: intent.expiresAt,
		createdAt: intent.createdAt,
		updatedAt: intent.updatedAt,
		result,
		approvalUrl:
			intent.state === "awaiting_approval"
				? `${publicOrigin}/approvals/${intent.id}?publisher=${encodeURIComponent(publisherDid)}`
				: null,
	};
}

async function authorizeIntent(
	request: Request,
	configuration: ServiceConfiguration,
	intent: StoredIntent,
	publisherDid: string,
	requireCsrf: boolean,
	keyResolver?: JWTVerifyGetKey,
): Promise<IntentActor> {
	if (request.headers.has("authorization")) {
		const identity = await authenticateWorkload(request, configuration, keyResolver);
		const workloadDigest = await digestWorkloadIdempotencyIdentity(
			identity,
			publisherDid,
			intent.packageSlug,
			intent.version,
		);
		if (workloadDigest !== intent.workloadIdempotencyDigest) {
			throw new ApiError("ACCESS_DENIED", 403, "Release intent access denied");
		}
		return {
			realm: "oidc",
			identity: await digestWorkloadIdentity(identity),
			publisherDid,
		};
	}
	const session = await requirePublisherApplicationSession(
		request,
		env.PUBLISHER_DO,
		configuration.publicOrigin,
		{ requireCsrf },
	);
	if (session.publisherDid !== publisherDid) {
		throw new ApiError("ACCESS_DENIED", 403, "Release intent access denied");
	}
	return { realm: "publisher", identity: session.publisherDid, publisherDid };
}

export function matchIntentResourcePath(pathname: string): Readonly<Record<string, string>> | null {
	const match = INTENT_RESOURCE_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { intentId: match[1] } : null;
}

export function matchIntentCancelPath(pathname: string): Readonly<Record<string, string>> | null {
	const match = INTENT_CANCEL_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { intentId: match[1] } : null;
}

export async function handleSubmitReleaseIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: SubmitIntentDependencies = {},
): Promise<Response> {
	try {
		const idempotencyKey = requireIdempotencyKey(request);
		const identity = await authenticateWorkload(request, configuration, dependencies.keyResolver);
		const body = await readJsonObject(request, MAX_INTENT_BODY_BYTES);
		if (
			!hasExactKeys(body, ["publisherDid", "packageSlug", "version", "release"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"]) ||
			typeof body["packageSlug"] !== "string" ||
			!PACKAGE_SLUG_PATTERN.test(body["packageSlug"]) ||
			typeof body["version"] !== "string" ||
			!VERSION_PATTERN.test(body["version"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid release intent request");
		}
		const release = parseDelegatedReleaseSourceRecord(body["release"], {
			packageSlug: body["packageSlug"],
			version: body["version"],
		});
		if (!release) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid release intent request");
		}
		const publisherDid = body["publisherDid"];
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const workloadIdempotencyDigest = await digestWorkloadIdempotencyIdentity(
			identity,
			publisherDid,
			release.package,
			release.version,
		);
		const releaseInputJson = JSON.stringify({ release });
		if (releaseInputJson.length > MAX_RELEASE_INPUT_CHARS) {
			throw new ApiError("INVALID_REQUEST", 413, "Release intent is too large");
		}
		const requestDigest = await digest(["release-intent", 1, publisherDid, release]);
		const now = dependencies.now?.() ?? Date.now();
		const replay = await publisher.findIdempotentIntent(
			publisherDid,
			workloadIdempotencyDigest,
			idempotencyKey,
			now,
		);
		if (replay) {
			if (replay.requestDigest !== requestDigest) {
				throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
			}
		}
		const admission = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).getAdmissionDecision(publisherDid);
		if (!admission.allowed) {
			throw new ApiError(
				admission.code === "PUBLISHER_SUSPENDED" ? "PUBLISHER_SUSPENDED" : "SERVICE_PAUSED",
				503,
				admission.code === "PUBLISHER_SUSPENDED"
					? "Publisher is suspended"
					: "Release admission is paused",
			);
		}
		const policy = await publisher.getWorkloadPolicy(publisherDid, release.package);
		if (
			!policy ||
			!evaluateWorkloadPolicy(identity, policy).ok ||
			(replay !== null && replay.intent.workloadPolicyVersion !== policy.stateVersion)
		) {
			throw new ApiError("WORKLOAD_NOT_ALLOWED", 403, "Workload is not authorized");
		}
		if (replay) {
			const started = await (dependencies.startWorkflow ?? startReleaseIntentWorkflow)(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				publisherDid,
				replay.intent.id,
			);
			if (!started.ok) {
				throw new ApiError("WORKFLOW_UNAVAILABLE", 503, "Release Workflow is unavailable");
			}
			const current = (await publisher.getIntent(publisherDid, replay.intent.id)) ?? replay.intent;
			return apiSuccess(
				{
					intent: await serializeIntentResource(publisherDid, current, configuration.publicOrigin),
					replayed: true,
				},
				requestId,
			);
		}
		const workloadRateKey = await digest([
			"intent-rate-limit",
			1,
			identity.repository.id,
			identity.workflow.ref,
			release.package,
		]);
		const rateLimit = await publisher.consumeIntentRateLimit({
			publisherDid,
			repositoryId: identity.repository.id,
			workloadKey: workloadRateKey,
			idempotencyKey,
			expiresAt: now + INTENT_LIFETIME_MS,
			now,
		});
		if (!rateLimit.ok) {
			writeOperationsMetric({
				event: "intent_rate_limited",
				ownerHash: workloadRateKey,
				outcome: "denied",
				scope: rateLimit.scope,
				requestId,
			});
			console.warn(
				JSON.stringify({
					event: "release_intent_rate_limited",
					requestId,
					scope: rateLimit.scope,
					workloadKey: workloadRateKey,
					retryAt: rateLimit.retryAt,
				}),
			);
			const response = apiFailure(
				new ApiError("WORKLOAD_RATE_LIMITED", 429, "Release intent rate limit exceeded"),
				requestId,
			);
			const headers = new Headers(response.headers);
			headers.set("retry-after", String(Math.max(1, Math.ceil((rateLimit.retryAt - now) / 1000))));
			return new Response(response.body, { status: response.status, headers });
		}
		const workloadIdentityDigest = await digestWorkloadIdentity(identity);
		const created = await publisher.createIntent({
			publisherDid,
			intentId: dependencies.intentId?.(now) ?? ulid(now),
			packageSlug: release.package,
			version: release.version,
			workloadPolicyVersion: policy.stateVersion,
			workloadIdentityDigest,
			workloadIdempotencyDigest,
			idempotencyKey,
			requestDigest,
			workloadIdentityJson: JSON.stringify(identity),
			releaseInputJson,
			expiresAt: now + INTENT_LIFETIME_MS,
			now,
		});
		if (!created.ok) {
			if (created.code === "IDEMPOTENCY_CONFLICT") {
				throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
			}
			if (created.code === "RESERVATION_CONFLICT") {
				throw new ApiError("VERSION_RESERVED", 409, "Package version is already reserved");
			}
			if (created.code === "PUBLISHER_SUSPENDED") {
				throw new ApiError("PUBLISHER_SUSPENDED", 403, "Publisher is suspended");
			}
			throw new ApiError("WORKLOAD_NOT_ALLOWED", 403, "Workload is not authorized");
		}
		const started = await (dependencies.startWorkflow ?? startReleaseIntentWorkflow)(
			env.RELEASE_INTENT_WORKFLOW,
			env.PUBLISHER_DO,
			publisherDid,
			created.intent.id,
		);
		if (!started.ok) {
			throw new ApiError("WORKFLOW_UNAVAILABLE", 503, "Release Workflow is unavailable");
		}
		const current = (await publisher.getIntent(publisherDid, created.intent.id)) ?? created.intent;
		return apiSuccess(
			{
				intent: await serializeIntentResource(publisherDid, current, configuration.publicOrigin),
				replayed: created.replayed,
			},
			requestId,
			created.replayed ? 200 : 202,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleDryRunReleaseIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: DryRunIntentDependencies = {},
): Promise<Response> {
	try {
		const identity = await authenticateWorkload(request, configuration, dependencies.keyResolver);
		const body = await readJsonObject(request, MAX_INTENT_BODY_BYTES);
		if (
			!hasExactKeys(body, ["publisherDid", "packageSlug", "version", "release"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"]) ||
			typeof body["packageSlug"] !== "string" ||
			!PACKAGE_SLUG_PATTERN.test(body["packageSlug"]) ||
			typeof body["version"] !== "string" ||
			!VERSION_PATTERN.test(body["version"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid release intent request");
		}
		const release = parseDelegatedReleaseSourceRecord(body["release"], {
			packageSlug: body["packageSlug"],
			version: body["version"],
		});
		if (!release) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid release intent request");
		}
		const publisherDid = body["publisherDid"];
		const admission = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).getAdmissionDecision(publisherDid);
		if (!admission.allowed) {
			throw new ApiError(
				admission.code === "PUBLISHER_SUSPENDED" ? "PUBLISHER_SUSPENDED" : "SERVICE_PAUSED",
				503,
				admission.code === "PUBLISHER_SUSPENDED"
					? "Publisher is suspended"
					: "Release admission is paused",
			);
		}
		const policy = await env.PUBLISHER_DO.getByName(publisherDid).getWorkloadPolicyIfInitialized(
			publisherDid,
			release.package,
		);
		if (!policy || !evaluateWorkloadPolicy(identity, policy).ok) {
			throw new ApiError("WORKLOAD_NOT_ALLOWED", 403, "Workload is not authorized");
		}
		return apiSuccess(
			{
				allowed: true,
				publisherDid,
				packageSlug: release.package,
				version: release.version,
				workloadPolicyVersion: policy.stateVersion,
				workloadIdentityDigest: await digestWorkloadIdentity(identity),
				requestDigest: await digest(["release-intent", 1, publisherDid, release]),
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleGetReleaseIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	keyResolver?: JWTVerifyGetKey,
): Promise<Response> {
	try {
		const intentId = params["intentId"];
		if (!intentId || !ULID_PATTERN.test(intentId)) {
			throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		}
		const publisherDid = request.headers.has("authorization")
			? requirePublisherQuery(request)
			: (
					await requirePublisherApplicationSession(
						request,
						env.PUBLISHER_DO,
						configuration.publicOrigin,
					)
				).publisherDid;
		const intent = await env.PUBLISHER_DO.getByName(publisherDid).getIntent(publisherDid, intentId);
		if (!intent) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		await authorizeIntent(request, configuration, intent, publisherDid, false, keyResolver);
		return apiSuccess(
			{ intent: await serializeIntentResource(publisherDid, intent, configuration.publicOrigin) },
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleCancelReleaseIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	keyResolver?: JWTVerifyGetKey,
): Promise<Response> {
	try {
		const intentId = params["intentId"];
		if (!intentId || !ULID_PATTERN.test(intentId)) {
			throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		}
		const idempotencyKey = requireIdempotencyKey(request);
		const body = await readJsonObject(request);
		if (!hasExactKeys(body, [])) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid cancellation request");
		}
		const publisherDid = request.headers.has("authorization")
			? requirePublisherQuery(request)
			: (
					await requirePublisherApplicationSession(
						request,
						env.PUBLISHER_DO,
						configuration.publicOrigin,
						{ requireCsrf: true },
					)
				).publisherDid;
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const intent = await publisher.getIntent(publisherDid, intentId);
		if (!intent) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		const actor = await authorizeIntent(
			request,
			configuration,
			intent,
			publisherDid,
			true,
			keyResolver,
		);
		if (intent.state === "cancelled") {
			return apiSuccess(
				{ intent: await serializeIntentResource(publisherDid, intent, configuration.publicOrigin) },
				requestId,
			);
		}
		if (!CANCELLABLE_STATES.has(intent.state)) {
			throw new ApiError("INTENT_NOT_CANCELLABLE", 409, "Release intent cannot be cancelled");
		}
		const approverDids =
			intent.state === "awaiting_approval"
				? (await decodeAwaitingApprovalState(intent.stateDataJson)).approverDids
				: [];
		const transition = await publisher.transitionIntent({
			publisherDid,
			intentId,
			expectedState: intent.state,
			expectedGeneration: intent.stateGeneration,
			toState: "cancelled",
			transitionDigest: await digest([
				"cancel-intent",
				1,
				publisherDid,
				intentId,
				idempotencyKey,
				actor.realm,
				actor.identity,
			]),
			actorRealm: actor.realm,
			actorIdentity: actor.identity,
			reasonCode: "CANCELLED",
			stateDataJson: JSON.stringify({ reasonCode: "CANCELLED" }),
		});
		if (!transition.ok) {
			throw new ApiError("INTENT_NOT_CANCELLABLE", 409, "Release intent cannot be cancelled");
		}
		if (approverDids.length > 0) {
			await invalidateApprovalChallenges(env.APPROVER_DO, approverDids, intentId, "CANCELLED");
		}
		if (transition.intent.workflowId) {
			try {
				const workflow = await env.RELEASE_INTENT_WORKFLOW.get(transition.intent.workflowId);
				const status = await workflow.status();
				if (
					status.status !== "complete" &&
					status.status !== "errored" &&
					status.status !== "terminated" &&
					status.status !== "unknown"
				) {
					await workflow.terminate();
				}
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "cancel_workflow_termination_failed",
						intentId,
						name: error instanceof Error ? error.name : "UnknownError",
					}),
				);
			}
		}
		return apiSuccess(
			{
				intent: await serializeIntentResource(
					publisherDid,
					transition.intent,
					configuration.publicOrigin,
				),
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
