import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import { decodeAwaitingApprovalState } from "../approvals/digest.js";
import { invalidateApprovalChallenges } from "../approvals/invalidation.js";
import type { ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../control-do/service-control-do.js";
import { serializeIntentResource } from "../intents/routes.js";
import type { IntentState } from "../publisher-do/publisher-do.js";
import { sanitizedDelegation } from "../publisher/routes.js";
import { restartReleaseIntentWorkflow } from "../workflows/start.js";

const PUBLISHER_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)$/;
const PUBLISHER_SUSPEND_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/suspend$/;
const PUBLISHER_REVOKE_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/revoke$/;
const INTENT_CANCEL_PATH_PATTERN = /^\/admin\/api\/intents\/([0-9A-HJKMNP-TV-Z]{26})\/cancel$/;
const INTENT_RECONCILE_PATH_PATTERN =
	/^\/admin\/api\/intents\/([0-9A-HJKMNP-TV-Z]{26})\/reconcile$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const CANCELLABLE_STATES: ReadonlySet<IntentState> = new Set([
	"received",
	"verifying",
	"verified",
	"awaiting_approval",
	"ready",
]);

export interface OperatorRouteDependencies {
	restartWorkflow?: typeof restartReleaseIntentWorkflow;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function requireActor(actor: AccessActor | null): AccessActor {
	if (!actor) throw new ApiError("ACCESS_AUTH_REQUIRED", 401, "Access authentication required");
	return actor;
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
	return value;
}

async function digest(value: unknown): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
		),
	);
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	throw error;
}

function matchPublisher(
	pathname: string,
	pattern: RegExp,
): Readonly<Record<string, string>> | null {
	const match = pattern.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export function matchOperatorPublisherPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchPublisher(pathname, PUBLISHER_PATH_PATTERN);
}

export function matchOperatorPublisherSuspendPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchPublisher(pathname, PUBLISHER_SUSPEND_PATH_PATTERN);
}

export function matchOperatorPublisherRevokePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchPublisher(pathname, PUBLISHER_REVOKE_PATH_PATTERN);
}

export function matchOperatorIntentCancelPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = INTENT_CANCEL_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { intentId: match[1] } : null;
}

export function matchOperatorIntentReconcilePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = INTENT_RECONCILE_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { intentId: match[1] } : null;
}

export async function handleGetOperatorPublisher(
	_request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const [delegation, control] = await Promise.all([
			env.PUBLISHER_DO.getByName(publisherDid).getDelegation(publisherDid),
			env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).readPublisherControl(
				actor,
				publisherDid,
			),
		]);
		return apiSuccess(
			{ publisher: { did: publisherDid, control, delegation: sanitizedDelegation(delegation) } },
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleSetOperatorPublisherSuspension(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		const idempotencyKey = requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const body = await readJsonObject(request);
		const suspended = body["suspended"];
		if (!hasExactKeys(body, ["suspended", "reasonCode"]) || typeof suspended !== "boolean") {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher suspension request");
		}
		const rawReasonCode = body["reasonCode"];
		let reasonCode: string | null;
		if (suspended) {
			if (typeof rawReasonCode !== "string" || !REASON_CODE_PATTERN.test(rawReasonCode)) {
				throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher suspension request");
			}
			reasonCode = rawReasonCode;
		} else {
			if (rawReasonCode !== null) {
				throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher suspension request");
			}
			reasonCode = null;
		}
		const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const requestDigest = await digest([
			"publisher-suspension",
			publisherDid,
			suspended,
			reasonCode,
		]);
		if (suspended) {
			const result = await control.setPublisherControl({
				actor,
				idempotencyKey,
				requestDigest,
				publisherDid,
				status: "suspended",
				reasonCode,
			});
			if (!result.ok) {
				throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
			}
			await publisher.setPublisherSuspended(publisherDid, true, actor.identity);
		} else {
			await publisher.setPublisherSuspended(publisherDid, false, actor.identity);
			const result = await control.setPublisherControl({
				actor,
				idempotencyKey,
				requestDigest,
				publisherDid,
				status: "allowed",
				reasonCode: null,
			});
			if (!result.ok) {
				throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
			}
		}
		const current = await control.readPublisherControl(actor, publisherDid);
		return apiSuccess({ publisher: { did: publisherDid, control: current } }, requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleRevokeOperatorPublisher(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const body = await readJsonObject(request);
		if (!hasExactKeys(body, [])) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher revocation request");
		}
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const current = await publisher.getDelegation(publisherDid);
		if (current && current.status !== "revoked") {
			const revoked = await publisher.revokeDelegation(
				publisherDid,
				current.stateVersion,
				actor.identity,
			);
			if (!revoked.ok) {
				throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Publisher authority changed");
			}
		}
		await publisher.revokeAllPublisherSessions(publisherDid, actor.identity);
		const delegation = await publisher.getDelegation(publisherDid);
		return apiSuccess(
			{
				publisher: {
					did: publisherDid,
					delegation: sanitizedDelegation(delegation),
					revokedBy: actor.identity,
				},
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleCancelOperatorIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		const idempotencyKey = requireIdempotencyKey(request);
		const intentId = params["intentId"];
		if (!intentId) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["publisherDid"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid intent cancellation request");
		}
		const publisherDid = body["publisherDid"];
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const intent = await publisher.getIntent(publisherDid, intentId);
		if (!intent) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
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
		const transitioned = await publisher.transitionIntent({
			publisherDid,
			intentId,
			expectedState: intent.state,
			expectedGeneration: intent.stateGeneration,
			toState: "cancelled",
			transitionDigest: await digest([
				"operator-cancel",
				publisherDid,
				intentId,
				idempotencyKey,
				actor.identity,
			]),
			actorRealm: "access",
			actorIdentity: actor.identity,
			reasonCode: "OPERATOR_CANCELLED",
			stateDataJson: JSON.stringify({ reasonCode: "OPERATOR_CANCELLED" }),
		});
		if (!transitioned.ok) {
			throw new ApiError("INTENT_NOT_CANCELLABLE", 409, "Release intent cannot be cancelled");
		}
		if (approverDids.length > 0) {
			await invalidateApprovalChallenges(env.APPROVER_DO, approverDids, intentId, "CANCELLED");
		}
		if (transitioned.intent.workflowId) {
			try {
				await (await env.RELEASE_INTENT_WORKFLOW.get(transitioned.intent.workflowId)).terminate();
			} catch {
				// The Durable Object transition is authoritative even if the Workflow already ended.
			}
		}
		return apiSuccess(
			{
				intent: await serializeIntentResource(
					publisherDid,
					transitioned.intent,
					configuration.publicOrigin,
				),
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleReconcileOperatorIntent(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
	dependencies: OperatorRouteDependencies = {},
): Promise<Response> {
	try {
		requireActor(accessActor);
		requireIdempotencyKey(request);
		const intentId = params["intentId"];
		if (!intentId) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["publisherDid"]) ||
			typeof body["publisherDid"] !== "string" ||
			!isDid(body["publisherDid"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid reconciliation request");
		}
		const publisherDid = body["publisherDid"];
		const result = await (dependencies.restartWorkflow ?? restartReleaseIntentWorkflow)(
			env.RELEASE_INTENT_WORKFLOW,
			env.PUBLISHER_DO,
			publisherDid,
			intentId,
		);
		if (!result.ok) {
			throw new ApiError(
				result.code === "INTENT_NOT_FOUND" ? "NOT_FOUND" : "WORKFLOW_UNAVAILABLE",
				result.code === "INTENT_NOT_FOUND" ? 404 : 409,
				result.code === "INTENT_NOT_FOUND"
					? "Release intent not found"
					: "Release intent cannot be reconciled",
			);
		}
		const intent = await env.PUBLISHER_DO.getByName(publisherDid).getIntent(publisherDid, intentId);
		if (!intent) throw new ApiError("NOT_FOUND", 404, "Release intent not found");
		return apiSuccess(
			{
				intent: await serializeIntentResource(publisherDid, intent, configuration.publicOrigin),
				restarted: result.restarted,
			},
			requestId,
			result.restarted ? 202 : 200,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
