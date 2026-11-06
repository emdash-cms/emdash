import { safeParse } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import type { AuthenticationResponse } from "@emdash-cms/auth/passkey";
import { NSID, PackageRelease, PackageReleaseExtension } from "@emdash-cms/registry-lexicons";
import { env } from "cloudflare:workers";
import { base64url } from "jose";

import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import {
	ApproverSessionError,
	requireApproverApplicationSession,
} from "../approver-session/session.js";
import type { ServiceConfiguration } from "../config.js";
import { ApprovalAuthorityError, loadApprovalIntent, verifyCurrentApprover } from "./authority.js";
import type { ApprovalEvidence } from "./digest.js";
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

async function digest(value: unknown): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
		),
	);
}

function evidenceInvalid(): never {
	throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const item = value[key];
	return isRecord(item) ? item : evidenceInvalid();
}

function stringField(value: Record<string, unknown>, key: string): string {
	const item = value[key];
	return typeof item === "string" ? item : evidenceInvalid();
}

function integerField(value: Record<string, unknown>, key: string): number {
	const item = value[key];
	return Number.isSafeInteger(item) ? Number(item) : evidenceInvalid();
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
	const item = value[key];
	return item === null || typeof item === "string" ? item : evidenceInvalid();
}

async function storedWorkloadSource(workloadIdentityJson: string, expectedDigest: string) {
	let workload: unknown;
	try {
		workload = JSON.parse(workloadIdentityJson);
	} catch {
		evidenceInvalid();
	}
	if (!isRecord(workload)) evidenceInvalid();
	const repository = recordField(workload, "repository");
	const workflow = recordField(workload, "workflow");
	const run = recordField(workload, "run");
	const issuer = stringField(workload, "issuer");
	const visibility = stringField(repository, "visibility");
	const refType = stringField(run, "refType");
	const runnerEnvironment = stringField(run, "runnerEnvironment");
	if (
		issuer !== "github-actions" ||
		(visibility !== "public" && visibility !== "private" && visibility !== "internal") ||
		(refType !== "branch" && refType !== "tag") ||
		(runnerEnvironment !== "github-hosted" && runnerEnvironment !== "self-hosted")
	) {
		evidenceInvalid();
	}
	const source = {
		repository: stringField(repository, "name"),
		workflowRef: stringField(workflow, "ref"),
		commitSha: stringField(run, "commitSha"),
		runId: stringField(run, "id"),
		actor: stringField(run, "actor"),
	};
	const actualDigest = await digest([
		"emdash-release-service",
		"workload-identity",
		1,
		issuer,
		stringField(workload, "subject"),
		stringField(workload, "tokenId"),
		source.repository,
		stringField(repository, "id"),
		stringField(repository, "owner"),
		stringField(repository, "ownerId"),
		visibility,
		source.workflowRef,
		stringField(workflow, "sha"),
		nullableStringField(workflow, "jobRef"),
		nullableStringField(workflow, "jobSha"),
		source.runId,
		integerField(run, "attempt"),
		source.actor,
		stringField(run, "actorId"),
		stringField(run, "eventName"),
		stringField(run, "ref"),
		refType,
		source.commitSha,
		nullableStringField(run, "environment"),
		runnerEnvironment,
		integerField(workload, "issuedAt"),
		integerField(workload, "expiresAt"),
	]);
	if (actualDigest !== expectedDigest) evidenceInvalid();
	return source;
}

async function storedReleaseReview(releaseInputJson: string, evidence: ApprovalEvidence) {
	let input: unknown;
	try {
		input = JSON.parse(releaseInputJson);
	} catch {
		evidenceInvalid();
	}
	if (!isRecord(input) || !isRecord(input["release"])) evidenceInvalid();
	const release = safeParse(PackageRelease.mainSchema, input["release"]);
	if (!release.ok) evidenceInvalid();
	const extension = safeParse(
		PackageReleaseExtension.mainSchema,
		release.value.extensions?.[NSID.packageReleaseExtension],
	);
	if (!extension.ok || !extension.value.provenance) evidenceInvalid();
	const provenance = extension.value.provenance;
	if (
		release.value.package !== evidence.packageSlug ||
		release.value.version !== evidence.version ||
		release.value.artifacts.package.checksum !== evidence.artifactChecksum ||
		provenance.checksum !== evidence.provenanceChecksum ||
		(await digest(["release-intent", 1, evidence.publisherDid, release.value])) !==
			evidence.releaseInputDigest
	) {
		evidenceInvalid();
	}
	return {
		artifact: {
			url: release.value.artifacts.package.url,
			checksum: release.value.artifacts.package.checksum,
		},
		provenance: {
			url: provenance.url,
			checksum: provenance.checksum,
			predicateType: provenance.predicateType,
			sourceRepository: provenance.sourceRepository,
			builderId: provenance.builderId,
		},
	};
}

async function storedAccessDiff(resultJson: string | null, expectedDigest: string) {
	if (!resultJson) throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	let result: unknown;
	let diff: unknown;
	try {
		result = JSON.parse(resultJson);
		if (!isRecord(result) || typeof result["accessDiffJson"] !== "string") throw new Error();
		diff = JSON.parse(result["accessDiffJson"]);
	} catch {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	if (
		!isRecord(diff) ||
		typeof diff["escalation"] !== "boolean" ||
		!Array.isArray(diff["changes"])
	) {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	if ((await digest(diff)) !== expectedDigest) evidenceInvalid();
	const changes = diff["changes"].map((change) => {
		if (
			!isRecord(change) ||
			typeof change["kind"] !== "string" ||
			typeof change["category"] !== "string" ||
			(change["operation"] !== undefined && typeof change["operation"] !== "string") ||
			!Array.isArray(change["path"]) ||
			change["path"].some((part) => typeof part !== "string") ||
			typeof change["escalation"] !== "boolean"
		) {
			throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
		}
		return {
			kind: change["kind"],
			category: change["category"],
			operation: typeof change["operation"] === "string" ? change["operation"] : null,
			path: change["path"],
			escalation: change["escalation"],
		};
	});
	return { escalation: diff["escalation"], changes };
}

async function approvalReview(
	workloadIdentityJson: string,
	releaseInputJson: string,
	policyDecisionJson: string | null,
	evidence: ApprovalEvidence,
) {
	const [source, releaseReview, accessDiff] = await Promise.all([
		storedWorkloadSource(workloadIdentityJson, evidence.workloadIdentityDigest),
		storedReleaseReview(releaseInputJson, evidence),
		storedAccessDiff(policyDecisionJson, evidence.declaredAccessDiffDigest),
	]);
	return {
		source,
		...releaseReview,
		accessDiff,
	};
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
		await verifyCurrentApprover(loaded.evidence, loaded.approverDids, session.approverDid);
		const policyDecision = await env.PUBLISHER_DO.getByName(
			loaded.evidence.publisherDid,
		).getVerificationStep(loaded.evidence.publisherDid, loaded.intent.id, "policy-decision");
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
				review: await approvalReview(
					loaded.intent.workloadIdentityJson,
					loaded.intent.releaseInputJson,
					policyDecision?.resultJson ?? null,
					loaded.evidence,
				),
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
		await verifyCurrentApprover(loaded.evidence, loaded.approverDids, session.approverDid);
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
			await verifyCurrentApprover(loaded.evidence, loaded.approverDids, session.approverDid);
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
		await verifyCurrentApprover(loaded.evidence, loaded.approverDids, session.approverDid);
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
