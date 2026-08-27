import { isDid } from "@atcute/lexicons/syntax";
import type { AuthenticationResponse } from "@emdash-cms/auth/passkey";
import { env } from "cloudflare:workers";

import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import {
	ApproverSessionError,
	requireApproverApplicationSession,
} from "../approver-session/session.js";
import type { ServiceConfiguration } from "../config.js";
import { ApprovalAuthorityError, loadApprovalIntent, verifyCurrentApprover } from "./authority.js";
import {
	ApprovalPasskeyError,
	beginApprovalDecision,
	completeApprovalDecision,
} from "./passkeys.js";

const APPROVAL_PATH_PREFIX = "/v1/approvals/";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_JSON_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiError("INVALID_REQUEST", 415, "Expected an application/json request body");
	}
	if (!request.body) throw new ApiError("INVALID_REQUEST", 400, "Request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_JSON_BODY_BYTES) {
				await reader.cancel();
				throw new ApiError("INVALID_REQUEST", 413, "Request body is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new ApiError("INVALID_REQUEST", 400, "Request body is not valid JSON");
	}
	if (!isRecord(parsed))
		throw new ApiError("INVALID_REQUEST", 400, "Request body must be an object");
	return parsed;
}

function requireBase64Url(value: unknown, maximum = MAX_JSON_BODY_BYTES): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > maximum ||
		!BASE64URL_PATTERN.test(value)
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey assertion");
	}
	return value;
}

function parseAuthenticationResponse(value: unknown): AuthenticationResponse {
	if (!isRecord(value) || !isRecord(value["response"]) || value["type"] !== "public-key") {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey assertion");
	}
	const response = value["response"];
	const id = requireBase64Url(value["id"], 1024);
	const rawId = requireBase64Url(value["rawId"], 1024);
	if (rawId !== id) throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey assertion");
	return {
		id,
		rawId,
		type: "public-key",
		response: {
			clientDataJSON: requireBase64Url(response["clientDataJSON"]),
			authenticatorData: requireBase64Url(response["authenticatorData"]),
			signature: requireBase64Url(response["signature"]),
			...(response["userHandle"] !== undefined
				? { userHandle: requireBase64Url(response["userHandle"]) }
				: {}),
		},
		...(value["authenticatorAttachment"] === "platform" ||
		value["authenticatorAttachment"] === "cross-platform"
			? { authenticatorAttachment: value["authenticatorAttachment"] }
			: {}),
	};
}

function passkeyRelyingParty(publicOrigin: string) {
	const url = new URL(publicOrigin);
	return { rpId: url.hostname, origin: url.origin };
}

function publisherDid(request: Request): string {
	const values = new URL(request.url).searchParams.getAll("publisher");
	const value = values[0];
	if (values.length !== 1 || !value || !isDid(value)) {
		throw new ApiError("INVALID_REQUEST", 400, "Publisher DID is required");
	}
	return value;
}

function intentId(params: Readonly<Record<string, string>>): string {
	const value = params["intentId"];
	if (!value || !ULID_PATTERN.test(value)) throw new ApiError("NOT_FOUND", 404, "Not found");
	return value;
}

function parseDecision(value: unknown): "approve" | "reject" {
	if (value !== "approve" && value !== "reject") {
		throw new ApiError("INVALID_REQUEST", 400, "Decision must be approve or reject");
	}
	return value;
}

function mapApprovalError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (error instanceof ApproverSessionError) {
		return new ApiError(
			error.code === "APPROVER_SUSPENDED" ? "APPROVER_SUSPENDED" : "APPROVER_SESSION_INVALID",
			error.code === "APPROVER_SUSPENDED" ? 403 : 401,
			"Approver session is not valid",
		);
	}
	if (error instanceof ApprovalAuthorityError) {
		if (error.code === "APPROVER_NOT_AUTHORIZED") {
			return new ApiError("NOT_FOUND", 404, "Approval not found");
		}
		if (error.code === "PROFILE_CHANGED") {
			return new ApiError("PROFILE_CHANGED", 409, "Package profile changed after verification");
		}
		if (error.code === "PROFILE_FETCH_FAILED") {
			return new ApiError("PROFILE_FETCH_FAILED", 503, "Package profile could not be verified");
		}
		return new ApiError("NOT_FOUND", 404, "Approval not found");
	}
	if (error instanceof ApprovalPasskeyError) {
		return new ApiError("APPROVAL_INVALID", 400, "Passkey approval could not be verified");
	}
	throw error;
}

function matchApprovalPath(
	pathname: string,
	withOptions: boolean,
): Readonly<Record<string, string>> | null {
	if (!pathname.startsWith(APPROVAL_PATH_PREFIX)) return null;
	const parts = pathname.slice(APPROVAL_PATH_PREFIX.length).split("/");
	if (
		(withOptions && (parts.length !== 2 || parts[1] !== "options")) ||
		(!withOptions && parts.length !== 1)
	) {
		return null;
	}
	const value = parts[0];
	return value && ULID_PATTERN.test(value) ? { intentId: value } : null;
}

async function notifyApprovalWorkflow(
	workflowIntentId: string,
	decision: "approve" | "reject",
	approvalDigest: string,
): Promise<void> {
	try {
		const instance = await env.RELEASE_INTENT_WORKFLOW.get(workflowIntentId);
		await instance.sendEvent({
			type: "approval-decision",
			payload: { decision, approvalDigest },
		});
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "approval_workflow_notification_failed",
				intentId: workflowIntentId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}

export function matchApprovalResourcePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchApprovalPath(pathname, false);
}

export function matchApprovalOptionsPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchApprovalPath(pathname, true);
}

export async function handleGetApproval(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
		);
		const loaded = await loadApprovalIntent(
			env.PUBLISHER_DO,
			publisherDid(request),
			intentId(params),
		);
		await verifyCurrentApprover(loaded.evidence, session.approverDid);
		return apiSuccess(
			{
				intent: {
					id: loaded.intent.id,
					packageSlug: loaded.intent.packageSlug,
					version: loaded.intent.version,
					state: loaded.intent.state,
					expiresAt: loaded.intent.expiresAt,
				},
				evidence: loaded.evidence,
				evidenceDigest: loaded.evidenceDigest,
			},
			requestId,
		);
	} catch (error) {
		return apiFailure(mapApprovalError(error), requestId);
	}
}

export async function handleBeginApprovalDecision(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const body = await readJsonBody(request);
		if (Object.keys(body).length !== 1) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid approval request");
		}
		const decision = parseDecision(body["decision"]);
		const publisher = publisherDid(request);
		const intent = intentId(params);
		const loaded = await loadApprovalIntent(env.PUBLISHER_DO, publisher, intent);
		if (loaded.intent.state !== "awaiting_approval") {
			throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
		}
		await verifyCurrentApprover(loaded.evidence, session.approverDid);
		const result = await beginApprovalDecision(
			env.APPROVER_DO.getByName(session.approverDid),
			{
				approverDid: session.approverDid,
				publisherDid: publisher,
				intentId: intent,
				evidenceDigest: loaded.evidenceDigest,
				decision,
			},
			passkeyRelyingParty(configuration.publicOrigin),
		);
		return apiSuccess(result.options, requestId);
	} catch (error) {
		return apiFailure(mapApprovalError(error), requestId);
	}
}

export async function handleCompleteApprovalDecision(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const body = await readJsonBody(request);
		if (
			Object.keys(body).length !== 3 ||
			typeof body["idempotencyKey"] !== "string" ||
			!IDEMPOTENCY_KEY_PATTERN.test(body["idempotencyKey"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid approval request");
		}
		const decision = parseDecision(body["decision"]);
		const response = parseAuthenticationResponse(body["response"]);
		const publisher = publisherDid(request);
		const intent = intentId(params);
		const loaded = await loadApprovalIntent(env.PUBLISHER_DO, publisher, intent);
		const alreadyApplied =
			loaded.appliedDecision === decision && loaded.appliedApproverDid === session.approverDid;
		if (loaded.intent.state !== "awaiting_approval" && !alreadyApplied) {
			throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
		}
		if (!alreadyApplied) {
			await verifyCurrentApprover(loaded.evidence, session.approverDid);
		}
		const result = await completeApprovalDecision(
			env.APPROVER_DO.getByName(session.approverDid),
			{
				approverDid: session.approverDid,
				publisherDid: publisher,
				intentId: intent,
				evidenceDigest: loaded.evidenceDigest,
				decision,
			},
			body["idempotencyKey"],
			response,
			passkeyRelyingParty(configuration.publicOrigin),
		);
		if (!result.ok) {
			return apiFailure(
				new ApiError(
					"APPROVAL_INVALID",
					result.code === "CREDENTIAL_NOT_FOUND" ? 400 : 409,
					"Passkey approval could not be accepted",
				),
				requestId,
			);
		}
		if (alreadyApplied) {
			if (!result.replayed || loaded.appliedApprovalDigest !== result.receipt.approvalDigest) {
				throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
			}
			if (loaded.intent.workflowId === intent) {
				await notifyApprovalWorkflow(intent, decision, result.receipt.approvalDigest);
			}
			return apiSuccess({ receipt: result.receipt, intent: loaded.intent }, requestId);
		}
		await verifyCurrentApprover(loaded.evidence, session.approverDid);
		if (loaded.intent.expiresAt <= Date.now()) {
			throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
		}
		const targetState = decision === "approve" ? "ready" : "rejected";
		const transition = await env.PUBLISHER_DO.getByName(publisher).transitionIntent({
			publisherDid: publisher,
			intentId: intent,
			expectedState: "awaiting_approval",
			expectedGeneration: loaded.approvalGeneration,
			toState: targetState,
			transitionDigest: result.receipt.approvalDigest,
			actorRealm: "approver",
			actorIdentity: session.approverDid,
			reasonCode: decision === "approve" ? "APPROVED" : "REJECTED",
			stateDataJson: JSON.stringify({ approvalReceipt: result.receipt }),
		});
		if (!transition.ok) {
			return apiFailure(
				new ApiError("INTENT_NOT_APPROVABLE", 409, "Release intent changed before approval"),
				requestId,
			);
		}
		if (loaded.intent.workflowId === intent) {
			await notifyApprovalWorkflow(intent, decision, result.receipt.approvalDigest);
		}
		return apiSuccess({ receipt: result.receipt, intent: transition.intent }, requestId);
	} catch (error) {
		return apiFailure(mapApprovalError(error), requestId);
	}
}
