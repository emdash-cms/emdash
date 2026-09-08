import type { PackageRelease } from "@emdash-cms/registry-lexicons";

import { parseDelegatedReleaseSourceRecord } from "./source-record.js";
import {
	TERMINAL_RELEASE_INTENT_STATES,
	type AbortPublisherRestoreResult,
	type AuditListOptions,
	type ConfirmWorkflowConnectionResult,
	type CreateWorkflowConnectionInvitationResult,
	type ControlAuditEventResource,
	type CursorPage,
	type DelegationResource,
	type DryRunReleaseIntentResult,
	type DirectoryIdentityKind,
	type DirectoryIdentityResource,
	type DirectoryListOptions,
	type EncryptionKeyStateResource,
	type EncryptionKeyStatusResource,
	type EncryptionVerificationResource,
	type EncryptionRotationPageInput,
	type EncryptionRotationResult,
	type MutationResult,
	type OperatorPublisherResource,
	type PreparePublisherRestoreResult,
	type PublisherArchiveKind,
	type PublisherApproverStatusResource,
	type PublisherApproverStatusResult,
	type PublisherAuditEventResource,
	type PublisherArchivePageInput,
	type PublisherArchivePageResult,
	type PublisherControlResource,
	type PublisherResource,
	type PublisherRestorePageInput,
	type PublisherRestorePageResult,
	type PutWorkloadPolicyInput,
	type RequestWorkflowConnectionInput,
	type RequestWorkflowConnectionResult,
	type ReleaseArtifactSlot,
	type ReleaseIntentResource,
	type ReleaseIntentResult,
	type ReleaseIntentState,
	type ReleaseServiceApiErrorCode,
	type ReleaseServiceClientErrorCode,
	type ServiceControlState,
	type StartPublisherArchiveResult,
	type StartEncryptionVerificationResult,
	type SubmitReleaseIntentInput,
	type SubmitReleaseIntentResult,
	type UploadReleaseArtifactInput,
	type UploadReleaseArtifactResult,
	type WorkloadPolicyResource,
	type WorkflowConnectionClaimResource,
	type WorkflowConnectionRequestResource,
} from "./types.js";

export type {
	DelegatedReleaseSourceArtifact,
	DelegatedReleaseSourceArtifacts,
	DelegatedReleaseSourceEnvelope,
	DelegatedReleaseSourceExtension,
	DelegatedReleaseSourceImageArtifact,
	DelegatedReleaseSourceRecord,
} from "./source-record.js";
export { parseDelegatedReleaseSourceRecord } from "./source-record.js";

export type {
	AbortPublisherRestoreResult,
	AuditListOptions,
	ConfirmWorkflowConnectionResult,
	CreateWorkflowConnectionInvitationResult,
	ControlAuditEventResource,
	CursorPage,
	DelegationResource,
	DryRunReleaseIntentResult,
	DirectoryIdentityKind,
	DirectoryIdentityResource,
	DirectoryListOptions,
	EncryptionKeyLifecycleStatus,
	EncryptionKeyStateResource,
	EncryptionKeyStatusResource,
	EncryptionVerificationResource,
	EncryptionRotationPageInput,
	EncryptionRotationResult,
	MutationResult,
	OperatorPublisherResource,
	PreparePublisherRestoreResult,
	PublisherArchiveKind,
	PublisherApproverEnrollmentState,
	PublisherApproverStatusResource,
	PublisherApproverStatusResult,
	PublisherAuditEventResource,
	PublisherArchivePageInput,
	PublisherArchivePageResult,
	PublisherControlResource,
	PublisherResource,
	PublisherRestorePageInput,
	PublisherRestorePageResult,
	PutWorkloadPolicyInput,
	RequestWorkflowConnectionInput,
	RequestWorkflowConnectionResult,
	ReleaseArtifactSlot,
	ReleaseIntentResource,
	ReleaseIntentResult,
	ReleaseIntentState,
	ReleaseServiceApiErrorCode,
	ReleaseServiceClientErrorCode,
	ServiceControlState,
	StartPublisherArchiveResult,
	StartEncryptionVerificationResult,
	SubmitReleaseIntentInput,
	SubmitReleaseIntentResult,
	UploadReleaseArtifactInput,
	UploadReleaseArtifactResult,
	WorkloadPolicyResource,
	WorkflowConnectionClaimResource,
	WorkflowConnectionRefScope,
	WorkflowConnectionRequestResource,
	WorkflowConnectionRequestState,
} from "./types.js";
export { TERMINAL_RELEASE_INTENT_STATES } from "./types.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CID_PATTERN = /^[A-Za-z0-9]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const IDEMPOTENCY_PREFIX_PATTERN = /[^A-Za-z0-9._:-]/g;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const SCREENSHOT_SLOT_PATTERN = /^screenshots\[([0-7])\]$/;
const DIGITS_PATTERN = /^[0-9]+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WORKFLOW_CONNECTION_INVITATION_PATTERN = /^ewci1_[A-Za-z0-9_-]{43}$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const DIRECTORY_SHARD_PATTERN = /^[0-9a-f]{2}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_ERROR_CODES: Readonly<Record<ReleaseServiceApiErrorCode, true>> = {
	ACCESS_DENIED: true,
	ACCESS_AUTH_INVALID: true,
	ACCESS_AUTH_REQUIRED: true,
	APPROVAL_INVALID: true,
	APPROVER_SESSION_INVALID: true,
	APPROVER_SUSPENDED: true,
	ARCHIVE_OPERATION_FAILED: true,
	AUTH_INVALID: true,
	CONFIGURATION_ERROR: true,
	CREDENTIAL_LIMIT_REACHED: true,
	CREDENTIAL_NOT_FOUND: true,
	CREDENTIAL_REVOKED: true,
	CSRF_INVALID: true,
	DELEGATION_REQUIRED: true,
	ENCRYPTION_OPERATION_FAILED: true,
	IDEMPOTENCY_KEY_INVALID: true,
	IDEMPOTENCY_CONFLICT: true,
	INTERNAL_ERROR: true,
	INVALID_REQUEST: true,
	INTENT_NOT_APPROVABLE: true,
	INTENT_NOT_CANCELLABLE: true,
	METHOD_NOT_ALLOWED: true,
	NOT_FOUND: true,
	OAUTH_AUTHORIZATION_FAILED: true,
	OAUTH_CALLBACK_INVALID: true,
	PACKAGE_PROFILE_REQUIRED: true,
	PROFILE_CHANGED: true,
	PROFILE_FETCH_FAILED: true,
	PUBLISHER_SESSION_INVALID: true,
	PUBLISHER_SUSPENDED: true,
	RELEASE_EXISTS: true,
	RESTORE_OPERATION_FAILED: true,
	SERVICE_PAUSED: true,
	SERVICE_UNAVAILABLE: true,
	VERSION_RESERVED: true,
	WORKFLOW_UNAVAILABLE: true,
	WORKFLOW_CONNECTION_CONFLICT: true,
	WORKFLOW_CONNECTION_EXPIRED: true,
	WORKFLOW_CONNECTION_INVITATION_EXPIRED: true,
	WORKFLOW_CONNECTION_INVITATION_INVALID: true,
	WORKFLOW_CONNECTION_INVITATION_LIMIT_REACHED: true,
	WORKFLOW_CONNECTION_INVITATION_REQUIRED: true,
	WORKFLOW_CONNECTION_LIMIT_REACHED: true,
	WORKFLOW_CONNECTION_NOT_FOUND: true,
	WORKLOAD_NOT_ALLOWED: true,
	WORKLOAD_RATE_LIMITED: true,
};
const RETRYABLE_ERROR_CODES: ReadonlySet<ReleaseServiceClientErrorCode> = new Set([
	"CONFIGURATION_ERROR",
	"INTERNAL_ERROR",
	"NETWORK_ERROR",
	"PROFILE_FETCH_FAILED",
	"PUBLISHER_SUSPENDED",
	"SERVICE_PAUSED",
	"SERVICE_UNAVAILABLE",
	"WORKFLOW_UNAVAILABLE",
	"WORKLOAD_RATE_LIMITED",
]);
const INTENT_STATES: Readonly<Record<ReleaseIntentState, true>> = {
	received: true,
	verifying: true,
	verified: true,
	awaiting_approval: true,
	ready: true,
	publishing: true,
	reconciling: true,
	published: true,
	invalid: true,
	rejected: true,
	cancelled: true,
	expired: true,
	failed: true,
	conflict: true,
};

type WorkloadTokenProvider = () => string | Promise<string>;
type CsrfTokenProvider = () => string | Promise<string>;

export interface ReleaseServiceClientOptions {
	serviceUrl: string;
	fetch?: typeof fetch;
	workloadToken?: string | WorkloadTokenProvider;
	csrfToken?: string | CsrfTokenProvider;
}

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface MutationOptions extends RequestOptions {
	idempotencyKey: string;
}

export interface WaitForIntentOptions extends RequestOptions {
	pollIntervalMs?: number;
	maxWaitMs?: number;
	stopOnApproval?: boolean;
	onUpdate?: (intent: ReleaseIntentResource) => void | Promise<void>;
}

export interface WaitForWorkflowConnectionOptions extends MutationOptions {
	pollIntervalMs?: number;
	maxWaitMs?: number;
	onUpdate?: (result: RequestWorkflowConnectionResult) => void | Promise<void>;
}

export interface OperatorClientOptions {
	serviceUrl: string;
	fetch?: typeof fetch;
}

export class ReleaseServiceError extends Error {
	readonly code: ReleaseServiceClientErrorCode;
	readonly status: number;
	readonly requestId: string | null;
	readonly retryable: boolean;
	readonly retryAfterMs: number | null;

	constructor(input: {
		code: ReleaseServiceClientErrorCode;
		message: string;
		status?: number;
		requestId?: string | null;
		retryAfterMs?: number | null;
	}) {
		super(input.message);
		this.name = "ReleaseServiceError";
		this.code = input.code;
		this.status = input.status ?? 0;
		this.requestId = input.requestId ?? null;
		this.retryable = RETRYABLE_ERROR_CODES.has(input.code);
		this.retryAfterMs = input.retryAfterMs ?? null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIntentState(value: unknown): value is ReleaseIntentState {
	return typeof value === "string" && Object.hasOwn(INTENT_STATES, value);
}

function isApiErrorCode(value: unknown): value is ReleaseServiceApiErrorCode {
	return typeof value === "string" && Object.hasOwn(API_ERROR_CODES, value);
}

function serviceOrigin(value: string): string {
	try {
		const url = new URL(value);
		const loopback =
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		if (
			(url.protocol !== "https:" && !loopback) ||
			url.username !== "" ||
			url.password !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.origin !== value
		) {
			throw new Error("invalid origin");
		}
		return url.origin;
	} catch {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Release service URL must be an HTTPS origin or a loopback development origin",
		});
	}
}

function requireIdempotencyKey(value: string): string {
	if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ReleaseServiceError({
			code: "IDEMPOTENCY_KEY_INVALID",
			message: "Idempotency key is invalid",
		});
	}
	return value;
}

export function createReleaseIdempotencyKey(prefix = "emdash"): string {
	const normalized = prefix.replaceAll(IDEMPOTENCY_PREFIX_PATTERN, "-").slice(0, 64);
	const value = `${normalized || "emdash"}-${crypto.randomUUID()}`;
	return requireIdempotencyKey(value);
}

function stringValue(value: Record<string, unknown>, key: string): string | null {
	const item = value[key];
	return typeof item === "string" ? item : null;
}

function nullableString(value: Record<string, unknown>, key: string): string | null | undefined {
	const item = value[key];
	return item === null || typeof item === "string" ? item : undefined;
}

function safeInteger(value: Record<string, unknown>, key: string): number | null {
	const item = value[key];
	return Number.isSafeInteger(item) ? Number(item) : null;
}

function nullableSafeInteger(
	value: Record<string, unknown>,
	key: string,
): number | null | undefined {
	const item = value[key];
	return item === null ? null : Number.isSafeInteger(item) ? Number(item) : undefined;
}

function parseIntentResult(value: unknown): ReleaseIntentResult | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const uri = stringValue(value, "uri");
	const cid = stringValue(value, "cid");
	return uri && cid ? { uri, cid } : undefined;
}

function parseIntent(value: unknown, serviceUrl?: string): ReleaseIntentResource {
	if (!isRecord(value)) throw invalidResponse();
	const id = stringValue(value, "id");
	const publisherDid = stringValue(value, "publisherDid");
	const packageSlug = stringValue(value, "packageSlug");
	const version = stringValue(value, "version");
	const state = value["state"];
	const stateGeneration = safeInteger(value, "stateGeneration");
	const reasonCode = nullableString(value, "reasonCode");
	const workflowId = nullableString(value, "workflowId");
	const expiresAt = safeInteger(value, "expiresAt");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	const result = parseIntentResult(value["result"]);
	const approvalUrl = nullableString(value, "approvalUrl");
	if (
		!id ||
		!ULID_PATTERN.test(id) ||
		!publisherDid ||
		!DID_PATTERN.test(publisherDid) ||
		!packageSlug ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!version ||
		!VERSION_PATTERN.test(version) ||
		!isIntentState(state) ||
		stateGeneration === null ||
		stateGeneration < 1 ||
		reasonCode === undefined ||
		workflowId === undefined ||
		expiresAt === null ||
		createdAt === null ||
		updatedAt === null ||
		result === undefined ||
		approvalUrl === undefined ||
		(workflowId !== null && !ULID_PATTERN.test(workflowId)) ||
		createdAt > updatedAt ||
		(result !== null &&
			(result.uri !==
				`at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}` ||
				!CID_PATTERN.test(result.cid)))
	) {
		throw invalidResponse();
	}
	if (approvalUrl !== null && serviceUrl) {
		let parsedApproval: URL;
		try {
			parsedApproval = new URL(approvalUrl);
		} catch {
			throw invalidResponse();
		}
		if (parsedApproval.origin !== serviceUrl) {
			throw invalidResponse();
		}
	}
	return {
		id,
		publisherDid,
		packageSlug,
		version,
		state,
		stateGeneration,
		reasonCode,
		workflowId,
		expiresAt,
		createdAt,
		updatedAt,
		result,
		approvalUrl,
	};
}

function parseDryRunIntent(value: unknown): DryRunReleaseIntentResult {
	if (!isRecord(value)) throw invalidResponse();
	const publisherDid = stringValue(value, "publisherDid");
	const packageSlug = stringValue(value, "packageSlug");
	const version = stringValue(value, "version");
	const workloadPolicyVersion = safeInteger(value, "workloadPolicyVersion");
	const workloadIdentityDigest = stringValue(value, "workloadIdentityDigest");
	const requestDigest = stringValue(value, "requestDigest");
	if (
		value["allowed"] !== true ||
		!publisherDid ||
		!DID_PATTERN.test(publisherDid) ||
		!packageSlug ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!version ||
		!VERSION_PATTERN.test(version) ||
		workloadPolicyVersion === null ||
		workloadPolicyVersion < 1 ||
		!workloadIdentityDigest ||
		!DIGEST_PATTERN.test(workloadIdentityDigest) ||
		!requestDigest ||
		!DIGEST_PATTERN.test(requestDigest)
	) {
		throw invalidResponse();
	}
	return {
		allowed: true,
		publisherDid,
		packageSlug,
		version,
		workloadPolicyVersion,
		workloadIdentityDigest,
		requestDigest,
	};
}

function parseStringArray(value: unknown): readonly string[] | null {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? [...value]
		: null;
}

function parsePolicy(value: unknown): WorkloadPolicyResource {
	if (!isRecord(value)) throw invalidResponse();
	const packageSlug = stringValue(value, "packageSlug");
	const repository = stringValue(value, "repository");
	const repositoryId = stringValue(value, "repositoryId");
	const repositoryOwnerId = stringValue(value, "repositoryOwnerId");
	const workflowRef = stringValue(value, "workflowRef");
	const allowedRefs = parseStringArray(value["allowedRefs"]);
	const allowedEnvironments = parseStringArray(value["allowedEnvironments"]);
	const stateVersion = safeInteger(value, "stateVersion");
	const authorizedBy = stringValue(value, "authorizedBy");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	if (
		!packageSlug ||
		!repository ||
		!repositoryId ||
		!repositoryOwnerId ||
		!workflowRef ||
		!allowedRefs ||
		!allowedEnvironments ||
		typeof value["active"] !== "boolean" ||
		stateVersion === null ||
		!authorizedBy ||
		createdAt === null ||
		updatedAt === null
	) {
		throw invalidResponse();
	}
	return {
		packageSlug,
		repository,
		repositoryId,
		repositoryOwnerId,
		workflowRef,
		allowedRefs,
		allowedEnvironments,
		active: value["active"],
		stateVersion,
		authorizedBy,
		createdAt,
		updatedAt,
	};
}

function parseWorkflowConnectionClaim(value: unknown): WorkflowConnectionClaimResource {
	if (!isRecord(value)) throw invalidResponse();
	const repository = stringValue(value, "repository");
	const repositoryId = stringValue(value, "repositoryId");
	const repositoryOwner = stringValue(value, "repositoryOwner");
	const repositoryOwnerId = stringValue(value, "repositoryOwnerId");
	const repositoryVisibility = value["repositoryVisibility"];
	const workflowRef = stringValue(value, "workflowRef");
	const ref = stringValue(value, "ref");
	const environment = nullableString(value, "environment");
	if (
		!repository ||
		!repositoryId ||
		!POSITIVE_INTEGER_PATTERN.test(repositoryId) ||
		!repositoryOwner ||
		!repositoryOwnerId ||
		!POSITIVE_INTEGER_PATTERN.test(repositoryOwnerId) ||
		(repositoryVisibility !== "public" &&
			repositoryVisibility !== "private" &&
			repositoryVisibility !== "internal") ||
		!workflowRef ||
		!ref ||
		environment === undefined
	) {
		throw invalidResponse();
	}
	return {
		repository,
		repositoryId,
		repositoryOwner,
		repositoryOwnerId,
		repositoryVisibility,
		workflowRef,
		ref,
		environment,
	};
}

function parseWorkflowConnectionRequest(value: unknown): WorkflowConnectionRequestResource {
	if (!isRecord(value)) throw invalidResponse();
	const id = stringValue(value, "id");
	const packageSlug = stringValue(value, "packageSlug");
	const state = value["state"];
	const refScope = value["refScope"];
	const expiresAt = safeInteger(value, "expiresAt");
	const createdAt = safeInteger(value, "createdAt");
	const confirmedAt = nullableSafeInteger(value, "confirmedAt");
	if (
		!id ||
		!ULID_PATTERN.test(id) ||
		!packageSlug ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		(state !== "pending" && state !== "confirmed" && state !== "expired") ||
		(refScope !== null && refScope !== "current_ref" && refScope !== "version_tags") ||
		expiresAt === null ||
		createdAt === null ||
		confirmedAt === undefined ||
		createdAt > expiresAt
	) {
		throw invalidResponse();
	}
	const claim = parseWorkflowConnectionClaim(value["claim"]);
	if (
		(state === "pending" && (refScope !== null || confirmedAt !== null)) ||
		(state === "confirmed" && (refScope === null || confirmedAt === null))
	) {
		throw invalidResponse();
	}
	return { id, packageSlug, state, claim, refScope, expiresAt, createdAt, confirmedAt };
}

function isReleaseArtifactSlot(value: unknown): value is ReleaseArtifactSlot {
	return (
		value === "package" ||
		value === "icon" ||
		value === "banner" ||
		value === "provenance" ||
		(typeof value === "string" && SCREENSHOT_SLOT_PATTERN.test(value))
	);
}

function artifactContentTypeValid(slot: ReleaseArtifactSlot, contentType: string): boolean {
	if (slot === "package") return contentType === "application/gzip";
	if (slot === "provenance") return contentType === "application/json";
	return (
		contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
	);
}

function stagedArtifactPath(slot: ReleaseArtifactSlot, checksum: string): string {
	if (slot === "provenance") return `/v1/provenance/${checksum}`;
	const normalizedSlot = slot.startsWith("screenshots[")
		? slot.replaceAll("[", "-").replaceAll("]", "")
		: slot;
	return `/v1/staged-artifacts/${normalizedSlot}/${checksum}`;
}

function parseDelegation(value: unknown): DelegationResource | null {
	if (value === null) return null;
	if (!isRecord(value)) throw invalidResponse();
	const releaseNsid = stringValue(value, "releaseNsid");
	const scope = stringValue(value, "scope");
	const issuer = nullableString(value, "issuer");
	const pdsUrl = nullableString(value, "pdsUrl");
	const expiresAt = value["expiresAt"];
	const refreshBefore = value["refreshBefore"];
	const status = value["status"];
	const stateVersion = safeInteger(value, "stateVersion");
	if (
		!releaseNsid ||
		!scope ||
		issuer === undefined ||
		pdsUrl === undefined ||
		(expiresAt !== null && !Number.isSafeInteger(expiresAt)) ||
		(refreshBefore !== null && !Number.isSafeInteger(refreshBefore)) ||
		(status !== "active" && status !== "revoked" && status !== "reauthorization_required") ||
		stateVersion === null
	) {
		throw invalidResponse();
	}
	return {
		releaseNsid,
		scope,
		issuer,
		pdsUrl,
		expiresAt: expiresAt === null ? null : Number(expiresAt),
		refreshBefore: refreshBefore === null ? null : Number(refreshBefore),
		status,
		stateVersion,
	};
}

function parsePublisher(value: unknown): PublisherResource {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const handleValue = value["handle"];
	const handle = typeof handleValue === "string" ? handleValue : null;
	const delegation = parseDelegation(value["delegation"]);
	const sessionExpiresAt = value["sessionExpiresAt"];
	if (
		!did ||
		!DID_PATTERN.test(did) ||
		(handleValue !== undefined && handleValue !== null && handle === null) ||
		(sessionExpiresAt !== undefined && !Number.isSafeInteger(sessionExpiresAt))
	) {
		throw invalidResponse();
	}
	return {
		did,
		handle,
		delegation,
		...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt: Number(sessionExpiresAt) }),
	};
}

function parseServiceState(value: unknown): ServiceControlState {
	if (!isRecord(value)) throw invalidResponse();
	const mode = value["mode"];
	const epoch = safeInteger(value, "epoch");
	const reasonCode = nullableString(value, "reasonCode");
	const changedBy = stringValue(value, "changedBy");
	const changedAt = safeInteger(value, "changedAt");
	if (
		(mode !== "active" && mode !== "admission-paused" && mode !== "publication-paused") ||
		epoch === null ||
		reasonCode === undefined ||
		!changedBy ||
		changedAt === null
	) {
		throw invalidResponse();
	}
	return { mode, epoch, reasonCode, changedBy, changedAt };
}

function parsePublisherControl(value: unknown): PublisherControlResource {
	if (!isRecord(value)) throw invalidResponse();
	const publisherDid = stringValue(value, "publisherDid");
	const status = value["status"];
	const reasonCode = nullableString(value, "reasonCode");
	const changedBy = stringValue(value, "changedBy");
	const changedAt = safeInteger(value, "changedAt");
	if (
		!publisherDid ||
		(status !== "allowed" && status !== "suspended") ||
		reasonCode === undefined ||
		!changedBy ||
		changedAt === null
	) {
		throw invalidResponse();
	}
	return { publisherDid, status, reasonCode, changedBy, changedAt };
}

function parseControlAuditEvent(value: unknown): ControlAuditEventResource {
	if (!isRecord(value)) throw invalidResponse();
	const sequence = safeInteger(value, "sequence");
	const eventType = stringValue(value, "eventType");
	const actorRealm = value["actorRealm"];
	const actorIdentity = stringValue(value, "actorIdentity");
	const actorRole = value["actorRole"];
	const subject = stringValue(value, "subject");
	const reasonCode = nullableString(value, "reasonCode");
	const createdAt = safeInteger(value, "createdAt");
	if (
		sequence === null ||
		sequence < 1 ||
		!eventType ||
		(actorRealm !== "access" && actorRealm !== "system") ||
		!actorIdentity ||
		(actorRole !== null &&
			actorRole !== "viewer" &&
			actorRole !== "reviewer" &&
			actorRole !== "admin") ||
		!subject ||
		reasonCode === undefined ||
		createdAt === null
	) {
		throw invalidResponse();
	}
	return {
		sequence,
		eventType,
		actorRealm,
		actorIdentity,
		actorRole,
		subject,
		reasonCode,
		createdAt,
	};
}

function parsePublisherAuditEvent(value: unknown): PublisherAuditEventResource {
	if (!isRecord(value)) throw invalidResponse();
	const sequence = safeInteger(value, "sequence");
	const eventType = stringValue(value, "eventType");
	const actorRealm = value["actorRealm"];
	const actorIdentity = stringValue(value, "actorIdentity");
	const actorHandleValue = value["actorHandle"];
	const actorHandle = typeof actorHandleValue === "string" ? actorHandleValue : null;
	const subject = stringValue(value, "subject");
	const reasonCode = nullableString(value, "reasonCode");
	const createdAt = safeInteger(value, "createdAt");
	if (
		sequence === null ||
		sequence < 1 ||
		!eventType ||
		(actorRealm !== "access" &&
			actorRealm !== "approver" &&
			actorRealm !== "oidc" &&
			actorRealm !== "publisher" &&
			actorRealm !== "system") ||
		!actorIdentity ||
		(actorHandleValue !== undefined && actorHandleValue !== null && actorHandle === null) ||
		!subject ||
		reasonCode === undefined ||
		createdAt === null
	) {
		throw invalidResponse();
	}
	return {
		sequence,
		eventType,
		actorRealm,
		actorIdentity,
		actorHandle,
		subject,
		reasonCode,
		createdAt,
	};
}

function parsePublisherApproverStatus(value: unknown): PublisherApproverStatusResource {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const handleValue = value["handle"];
	const handle = typeof handleValue === "string" ? handleValue : null;
	const status = value["status"];
	if (
		!did ||
		!DID_PATTERN.test(did) ||
		(handleValue !== undefined && handleValue !== null && handle === null) ||
		(status !== "enrolled" && status !== "not_enrolled" && status !== "revoked")
	) {
		throw invalidResponse();
	}
	return { did, handle, status };
}

function invalidResponse(requestId: string | null = null): ReleaseServiceError {
	return new ReleaseServiceError({
		code: "CLIENT_RESPONSE_INVALID",
		message: "Release service returned an invalid response",
		status: 502,
		requestId,
	});
}

function retryAfterMs(response: Response): number | null {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	if (DIGITS_PATTERN.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function parseErrorPayload(
	value: unknown,
	response: Response,
): { code: ReleaseServiceApiErrorCode; message: string; requestId: string | null } {
	if (!isRecord(value) || !isRecord(value["error"])) throw invalidResponse();
	const code = stringValue(value["error"], "code");
	const message = stringValue(value["error"], "message");
	const requestId = nullableString(value, "requestId");
	if (!isApiErrorCode(code) || !message || requestId === undefined) {
		throw invalidResponse(response.headers.get("x-request-id"));
	}
	return { code, message, requestId };
}

async function responseJson(response: Response): Promise<unknown> {
	const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") throw invalidResponse(response.headers.get("x-request-id"));
	try {
		return await response.json();
	} catch {
		throw invalidResponse(response.headers.get("x-request-id"));
	}
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason;
	await new Promise<void>((resolve, reject) => {
		const complete = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(complete, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

class BaseReleaseServiceClient {
	readonly serviceUrl: string;
	readonly fetch: typeof fetch;

	constructor(options: { serviceUrl: string; fetch?: typeof fetch }) {
		this.serviceUrl = serviceOrigin(options.serviceUrl);
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	protected async call<T>(
		path: string,
		init: RequestInit,
		parse: (value: unknown) => T,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetch(new URL(path, this.serviceUrl), init);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			throw new ReleaseServiceError({
				code: "NETWORK_ERROR",
				message: "Release service request failed",
			});
		}
		const payload = await responseJson(response);
		if (!response.ok) {
			const error = parseErrorPayload(payload, response);
			throw new ReleaseServiceError({
				...error,
				status: response.status,
				retryAfterMs: retryAfterMs(response),
			});
		}
		if (!isRecord(payload) || !("data" in payload)) {
			throw invalidResponse(response.headers.get("x-request-id"));
		}
		return parse(payload["data"]);
	}
}

export class ReleaseServiceClient extends BaseReleaseServiceClient {
	readonly #workloadToken: string | WorkloadTokenProvider | undefined;
	readonly #csrfToken: string | CsrfTokenProvider | undefined;

	constructor(options: ReleaseServiceClientOptions) {
		super(options);
		this.#workloadToken = options.workloadToken;
		this.#csrfToken = options.csrfToken;
	}

	async #token(): Promise<string> {
		const token =
			typeof this.#workloadToken === "function" ? await this.#workloadToken() : this.#workloadToken;
		if (!token || token.length > 16 * 1024 || token.includes(" ")) {
			throw new ReleaseServiceError({
				code: "AUTH_INVALID",
				message: "Workload token is unavailable",
			});
		}
		return token;
	}

	async #csrf(): Promise<string> {
		const token = typeof this.#csrfToken === "function" ? await this.#csrfToken() : this.#csrfToken;
		if (!token || !CSRF_TOKEN_PATTERN.test(token)) {
			throw new ReleaseServiceError({
				code: "CSRF_INVALID",
				message: "Publisher CSRF token is unavailable",
			});
		}
		return token;
	}

	async #workloadHeaders(idempotencyKey?: string): Promise<Headers> {
		const headers = new Headers({ authorization: `Bearer ${await this.#token()}` });
		if (idempotencyKey) headers.set("idempotency-key", requireIdempotencyKey(idempotencyKey));
		return headers;
	}

	async #publisherMutationHeaders(idempotencyKey: string): Promise<Headers> {
		return new Headers({
			"content-type": "application/json",
			"idempotency-key": requireIdempotencyKey(idempotencyKey),
			"x-emdash-request": "1",
			"x-emdash-csrf": await this.#csrf(),
		});
	}

	async submitIntent(
		input: SubmitReleaseIntentInput,
		options: MutationOptions,
	): Promise<SubmitReleaseIntentResult> {
		const release = parseDelegatedReleaseSourceRecord(input.release, {
			packageSlug: input.packageSlug,
			version: input.version,
		});
		if (!release) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Delegated release source record is invalid",
			});
		}
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(
			"/v1/release-intents",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ ...input, release }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return {
					intent: parseIntent(value["intent"], this.serviceUrl),
					replayed: value["replayed"],
				};
			},
		);
	}

	async uploadReleaseArtifact(
		input: UploadReleaseArtifactInput,
		options: MutationOptions,
	): Promise<UploadReleaseArtifactResult> {
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			!VERSION_PATTERN.test(input.version) ||
			!isReleaseArtifactSlot(input.slot) ||
			!CHECKSUM_PATTERN.test(input.checksum) ||
			!artifactContentTypeValid(input.slot, input.contentType) ||
			!(input.bytes instanceof Uint8Array) ||
			input.bytes.byteLength < 1
		) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Release artifact upload is invalid",
			});
		}
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-length", String(input.bytes.byteLength));
		headers.set("content-type", input.contentType);
		headers.set("x-emdash-publisher-did", input.publisherDid);
		headers.set("x-emdash-package", input.packageSlug);
		headers.set("x-emdash-version", input.version);
		headers.set("x-emdash-artifact-slot", input.slot);
		headers.set("x-emdash-checksum", input.checksum);
		return await this.call(
			"/v1/staged-artifacts",
			{
				method: "POST",
				headers,
				body: new Uint8Array(input.bytes),
				signal: options.signal,
			},
			(value) => {
				if (
					!isRecord(value) ||
					!isRecord(value["artifact"]) ||
					typeof value["replayed"] !== "boolean"
				) {
					throw invalidResponse();
				}
				const artifact = value["artifact"];
				const slot = artifact["slot"];
				const checksum = stringValue(artifact, "checksum");
				const contentType = stringValue(artifact, "contentType");
				const size = safeInteger(artifact, "size");
				const sourceUrl = stringValue(artifact, "sourceUrl");
				if (
					!isReleaseArtifactSlot(slot) ||
					slot !== input.slot ||
					checksum !== input.checksum ||
					contentType !== input.contentType ||
					size !== input.bytes.byteLength ||
					!sourceUrl
				) {
					throw invalidResponse();
				}
				let parsedSource: URL;
				try {
					parsedSource = new URL(sourceUrl);
				} catch {
					throw invalidResponse();
				}
				if (
					parsedSource.origin !== this.serviceUrl ||
					parsedSource.pathname !== stagedArtifactPath(input.slot, input.checksum) ||
					parsedSource.search !== "" ||
					parsedSource.hash !== ""
				) {
					throw invalidResponse();
				}
				return {
					artifact: { slot, checksum, contentType, size, sourceUrl },
					replayed: value["replayed"],
				};
			},
		);
	}

	async dryRunIntent(
		input: SubmitReleaseIntentInput,
		options: RequestOptions = {},
	): Promise<DryRunReleaseIntentResult> {
		const release = parseDelegatedReleaseSourceRecord(input.release, {
			packageSlug: input.packageSlug,
			version: input.version,
		});
		if (!release) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Delegated release source record is invalid",
			});
		}
		const headers = await this.#workloadHeaders();
		headers.set("content-type", "application/json");
		return await this.call(
			"/v1/release-intents/dry-run",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ ...input, release }),
				signal: options.signal,
			},
			parseDryRunIntent,
		);
	}

	async getIntent(
		publisherDid: string,
		intentId: string,
		options: RequestOptions = {},
	): Promise<ReleaseIntentResource> {
		const headers = await this.#workloadHeaders();
		return await this.call(
			`/v1/release-intents/${encodeURIComponent(intentId)}?publisher=${encodeURIComponent(publisherDid)}`,
			{ method: "GET", headers, signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async cancelIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<ReleaseIntentResource> {
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(
			`/v1/release-intents/${encodeURIComponent(intentId)}/cancel?publisher=${encodeURIComponent(publisherDid)}`,
			{ method: "POST", headers, body: "{}", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async waitForIntent(
		publisherDid: string,
		intentId: string,
		options: WaitForIntentOptions = {},
	): Promise<ReleaseIntentResource> {
		const pollIntervalMs = options.pollIntervalMs ?? 1_000;
		const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
		if (
			!Number.isSafeInteger(pollIntervalMs) ||
			pollIntervalMs < 0 ||
			!Number.isSafeInteger(maxWaitMs) ||
			maxWaitMs < 1
		) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Polling options are invalid",
			});
		}
		const deadline = Date.now() + maxWaitMs;
		for (;;) {
			const intent = await this.getIntent(publisherDid, intentId, { signal: options.signal });
			await options.onUpdate?.(intent);
			if (
				TERMINAL_RELEASE_INTENT_STATES.has(intent.state) ||
				((options.stopOnApproval ?? true) && intent.state === "awaiting_approval")
			) {
				return intent;
			}
			if (Date.now() >= deadline) {
				throw new ReleaseServiceError({
					code: "POLL_TIMEOUT",
					message: "Timed out waiting for release intent",
				});
			}
			await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
		}
	}

	async getPublisher(options: RequestOptions = {}): Promise<PublisherResource> {
		return await this.call(
			"/v1/publisher",
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async revokeDelegation(options: MutationOptions): Promise<PublisherResource> {
		return await this.call(
			"/v1/publisher/delegation",
			{
				method: "DELETE",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async requestWorkflowConnection(
		input: RequestWorkflowConnectionInput,
		options: MutationOptions,
	): Promise<RequestWorkflowConnectionResult> {
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			(input.invitationToken !== undefined &&
				!WORKFLOW_CONNECTION_INVITATION_PATTERN.test(input.invitationToken))
		) {
			throw invalidResponse();
		}
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(
			"/v1/workflow-connections",
			{
				method: "POST",
				headers,
				body: JSON.stringify(input),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				if (value["status"] === "connected") {
					return { status: "connected", policy: parsePolicy(value["policy"]) };
				}
				if (value["status"] !== "pending" || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				const request = parseWorkflowConnectionRequest(value["request"]);
				const approvalUrl = stringValue(value, "approvalUrl");
				if (!approvalUrl) throw invalidResponse();
				let parsedApproval: URL;
				try {
					parsedApproval = new URL(approvalUrl);
				} catch {
					throw invalidResponse();
				}
				if (
					parsedApproval.origin !== this.serviceUrl ||
					parsedApproval.pathname !== "/publisher" ||
					parsedApproval.searchParams.get("connection") !== request.id
				) {
					throw invalidResponse();
				}
				return { status: "pending", request, approvalUrl, replayed: value["replayed"] };
			},
		);
	}

	async createWorkflowConnectionInvitation(
		packageSlug: string,
		options: MutationOptions,
	): Promise<CreateWorkflowConnectionInvitationResult> {
		if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) throw invalidResponse();
		return await this.call(
			"/v1/publisher/workflow-connection-invitations",
			{
				method: "POST",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ packageSlug }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				const invitationToken = stringValue(value, "invitationToken");
				const returnedPackageSlug = stringValue(value, "packageSlug");
				const expiresAt = safeInteger(value, "expiresAt");
				if (
					!invitationToken ||
					!WORKFLOW_CONNECTION_INVITATION_PATTERN.test(invitationToken) ||
					returnedPackageSlug !== packageSlug ||
					expiresAt === null
				) {
					throw invalidResponse();
				}
				return { invitationToken, packageSlug: returnedPackageSlug, expiresAt };
			},
		);
	}

	async waitForWorkflowConnection(
		input: RequestWorkflowConnectionInput,
		options: WaitForWorkflowConnectionOptions,
	): Promise<WorkloadPolicyResource> {
		const pollIntervalMs = options.pollIntervalMs ?? 1_000;
		const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
		if (
			!Number.isSafeInteger(pollIntervalMs) ||
			pollIntervalMs < 0 ||
			!Number.isSafeInteger(maxWaitMs) ||
			maxWaitMs < 1
		) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Polling options are invalid",
			});
		}
		const deadline = Date.now() + maxWaitMs;
		for (;;) {
			const result = await this.requestWorkflowConnection(input, options);
			await options.onUpdate?.(result);
			if (result.status === "connected") return result.policy;
			if (Date.now() >= deadline) {
				throw new ReleaseServiceError({
					code: "POLL_TIMEOUT",
					message: "Timed out waiting for workflow approval",
				});
			}
			await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
		}
	}

	async listWorkflowConnections(
		options: RequestOptions = {},
	): Promise<WorkflowConnectionRequestResource[]> {
		return await this.call(
			"/v1/publisher/workflow-connections",
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
				return value["items"].map(parseWorkflowConnectionRequest);
			},
		);
	}

	async confirmWorkflowConnection(
		requestId: string,
		refScope: "current_ref" | "version_tags",
		options: MutationOptions,
	): Promise<ConfirmWorkflowConnectionResult> {
		if (
			!ULID_PATTERN.test(requestId) ||
			(refScope !== "current_ref" && refScope !== "version_tags")
		) {
			throw invalidResponse();
		}
		return await this.call(
			`/v1/publisher/workflow-connections/${encodeURIComponent(requestId)}/confirm`,
			{
				method: "POST",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ refScope }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return {
					request: parseWorkflowConnectionRequest(value["request"]),
					policy: parsePolicy(value["policy"]),
					replayed: value["replayed"],
				};
			},
		);
	}

	async rejectWorkflowConnection(requestId: string, options: MutationOptions): Promise<void> {
		if (!ULID_PATTERN.test(requestId)) throw invalidResponse();
		await this.call(
			`/v1/publisher/workflow-connections/${encodeURIComponent(requestId)}`,
			{
				method: "DELETE",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || value["rejected"] !== true) throw invalidResponse();
			},
		);
	}

	async listWorkloads(
		options: RequestOptions & { cursor?: string; limit?: number } = {},
	): Promise<CursorPage<WorkloadPolicyResource>> {
		const url = new URL("/v1/publisher/workloads", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, parsePolicy),
		);
	}

	async putWorkload(
		input: PutWorkloadPolicyInput,
		options: MutationOptions,
	): Promise<MutationResult<WorkloadPolicyResource>> {
		return await this.call(
			"/v1/publisher/workloads",
			{
				method: "POST",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify(input),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parsePolicy(value["policy"]), replayed: value["replayed"] };
			},
		);
	}

	async disableWorkload(
		packageSlug: string,
		expectedVersion: number,
		options: MutationOptions,
	): Promise<MutationResult<WorkloadPolicyResource>> {
		return await this.call(
			`/v1/publisher/workloads/${encodeURIComponent(packageSlug)}`,
			{
				method: "DELETE",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ expectedVersion }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parsePolicy(value["policy"]), replayed: value["replayed"] };
			},
		);
	}

	async listPublisherIntents(
		options: RequestOptions & { cursor?: string; limit?: number } = {},
	): Promise<CursorPage<ReleaseIntentResource>> {
		const url = new URL("/v1/publisher/intents", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, (item) => parseIntent(item, this.serviceUrl)),
		);
	}

	async listPublisherAudit(
		options: RequestOptions & AuditListOptions = {},
	): Promise<CursorPage<PublisherAuditEventResource>> {
		const url = new URL("/v1/publisher/audit", this.serviceUrl);
		if (options.cursor) {
			if (!POSITIVE_INTEGER_PATTERN.test(options.cursor)) {
				throw new ReleaseServiceError({
					code: "CLIENT_RESPONSE_INVALID",
					message: "Audit cursor is invalid",
				});
			}
			url.searchParams.set("cursor", options.cursor);
		}
		if (options.limit !== undefined) {
			if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
				throw new ReleaseServiceError({
					code: "CLIENT_RESPONSE_INVALID",
					message: "Audit limit is invalid",
				});
			}
			url.searchParams.set("limit", String(options.limit));
		}
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, parsePublisherAuditEvent),
		);
	}

	async getPublisherApproverStatus(packageSlug: string): Promise<PublisherApproverStatusResult> {
		if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Package slug is invalid",
			});
		}
		return await this.call(
			`/v1/publisher/workloads/${encodeURIComponent(packageSlug)}/approvers`,
			{ method: "GET", credentials: "include" },
			(value) => {
				if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
				const returnedPackageSlug = stringValue(value, "packageSlug");
				const profileCid = stringValue(value, "profileCid");
				if (returnedPackageSlug !== packageSlug || !profileCid || !CID_PATTERN.test(profileCid)) {
					throw invalidResponse();
				}
				return {
					packageSlug: returnedPackageSlug,
					profileCid,
					items: value["items"].map(parsePublisherApproverStatus),
				};
			},
		);
	}
}

function parsePage<T>(value: unknown, parseItem: (item: unknown) => T): CursorPage<T> {
	if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
	const nextCursor = value["nextCursor"];
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalidResponse();
	return {
		items: value["items"].map(parseItem),
		...(nextCursor ? { nextCursor } : {}),
	};
}

function parseDirectoryIdentity(value: unknown): DirectoryIdentityResource {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const shard = stringValue(value, "shard");
	const registeredAt = safeInteger(value, "registeredAt");
	const lastSeenAt = safeInteger(value, "lastSeenAt");
	if (
		(value["kind"] !== "approver" && value["kind"] !== "publisher") ||
		!did ||
		!DID_PATTERN.test(did) ||
		!shard ||
		!DIRECTORY_SHARD_PATTERN.test(shard) ||
		registeredAt === null ||
		registeredAt < 0 ||
		lastSeenAt === null ||
		lastSeenAt < registeredAt
	) {
		throw invalidResponse();
	}
	return { kind: value["kind"], did, shard, registeredAt, lastSeenAt };
}

function rotationPageInput(value: EncryptionRotationPageInput): EncryptionRotationPageInput {
	if (
		(value.afterCursor !== null &&
			(typeof value.afterCursor !== "string" || value.afterCursor.length === 0)) ||
		!Number.isSafeInteger(value.limit) ||
		value.limit < 1 ||
		value.limit > 100
	) {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Encryption rotation page is invalid",
		});
	}
	return value;
}

function parseEncryptionRotation(value: unknown): EncryptionRotationResult {
	if (!isRecord(value)) throw invalidResponse();
	const ownerDid = stringValue(value, "ownerDid");
	const targetKeyVersion = safeInteger(value, "targetKeyVersion");
	const scanned = safeInteger(value, "scanned");
	const rotated = safeInteger(value, "rotated");
	const raced = safeInteger(value, "raced");
	const nextCursor = value["nextCursor"];
	if (
		!ownerDid ||
		!DID_PATTERN.test(ownerDid) ||
		targetKeyVersion === null ||
		targetKeyVersion < 1 ||
		scanned === null ||
		scanned < 0 ||
		rotated === null ||
		rotated < 0 ||
		raced === null ||
		raced < 0 ||
		rotated + raced > scanned ||
		(nextCursor !== null && typeof nextCursor !== "string") ||
		typeof value["complete"] !== "boolean" ||
		value["complete"] !== (nextCursor === null && rotated === 0 && raced === 0)
	) {
		throw invalidResponse();
	}
	return {
		ownerDid,
		targetKeyVersion,
		scanned,
		rotated,
		raced,
		nextCursor,
		complete: value["complete"],
	};
}

function parseEncryptionKeyState(value: unknown): EncryptionKeyStateResource {
	if (!isRecord(value)) throw invalidResponse();
	const version = safeInteger(value, "version");
	const status = value["status"];
	const activatedAt = safeInteger(value, "activatedAt");
	const retiredAt = nullableSafeInteger(value, "retiredAt");
	const changedBy = stringValue(value, "changedBy");
	const updatedAt = safeInteger(value, "updatedAt");
	if (
		version === null ||
		version < 1 ||
		version > 2_147_483_647 ||
		(status !== "active" && status !== "readable" && status !== "retired") ||
		activatedAt === null ||
		activatedAt < 0 ||
		retiredAt === undefined ||
		(retiredAt !== null && retiredAt < activatedAt) ||
		(status === "retired") !== (retiredAt !== null) ||
		!changedBy ||
		updatedAt === null ||
		updatedAt < activatedAt
	) {
		throw invalidResponse();
	}
	return { version, status, activatedAt, retiredAt, changedBy, updatedAt };
}

function parseEncryptionVerification(value: unknown): EncryptionVerificationResource {
	if (!isRecord(value)) throw invalidResponse();
	const targetKeyVersion = safeInteger(value, "targetKeyVersion");
	const workflowId = stringValue(value, "workflowId");
	const publishers = safeInteger(value, "publishers");
	const approvers = safeInteger(value, "approvers");
	const records = safeInteger(value, "records");
	const rotated = safeInteger(value, "rotated");
	const verifiedAt = safeInteger(value, "verifiedAt");
	if (
		targetKeyVersion === null ||
		targetKeyVersion < 1 ||
		!workflowId ||
		!DIGEST_PATTERN.test(workflowId) ||
		publishers === null ||
		publishers < 0 ||
		approvers === null ||
		approvers < 0 ||
		records === null ||
		records < 0 ||
		rotated === null ||
		rotated < 0 ||
		verifiedAt === null ||
		verifiedAt < 0
	) {
		throw invalidResponse();
	}
	return {
		targetKeyVersion,
		workflowId,
		publishers,
		approvers,
		records,
		rotated,
		verifiedAt,
	};
}

function parseEncryptionKeyStatus(value: unknown): EncryptionKeyStatusResource {
	if (!isRecord(value) || !isRecord(value["configured"]) || !Array.isArray(value["keys"])) {
		throw invalidResponse();
	}
	const activeVersion = safeInteger(value["configured"], "activeVersion");
	const versions = value["configured"]["versions"];
	if (
		activeVersion === null ||
		activeVersion < 1 ||
		!Array.isArray(versions) ||
		versions.length === 0 ||
		versions.some(
			(version) =>
				!Number.isSafeInteger(version) || Number(version) < 1 || Number(version) > 2_147_483_647,
		) ||
		new Set(versions).size !== versions.length ||
		!versions.includes(activeVersion)
	) {
		throw invalidResponse();
	}
	const keys = value["keys"].map(parseEncryptionKeyState);
	if (
		new Set(keys.map((key) => key.version)).size !== keys.length ||
		keys.filter((key) => key.status === "active").length !== 1
	) {
		throw invalidResponse();
	}
	const verification =
		value["verification"] === null ? null : parseEncryptionVerification(value["verification"]);
	const controlledActiveVersion = keys.find((key) => key.status === "active")!.version;
	if (verification !== null && verification.targetKeyVersion !== controlledActiveVersion) {
		throw invalidResponse();
	}
	return {
		configured: { activeVersion, versions: versions.map(Number) },
		keys,
		verification,
	};
}

function archivePageInput(value: PublisherArchivePageInput): PublisherArchivePageInput {
	if (
		!ARCHIVE_ID_PATTERN.test(value.archiveId) ||
		(value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length === 0)) ||
		!Number.isSafeInteger(value.page) ||
		value.page < 0 ||
		value.page > 999_999
	) {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Publisher archive page is invalid",
		});
	}
	return value;
}

function isPublisherArchiveKind(value: unknown): value is PublisherArchiveKind {
	return (
		value === "audit-events" ||
		value === "intents" ||
		value === "metadata" ||
		value === "workload-policies"
	);
}

function parsePublisherArchivePage(value: unknown): PublisherArchivePageResult {
	if (!isRecord(value)) throw invalidResponse();
	const archiveId = stringValue(value, "archiveId");
	const ownerHash = stringValue(value, "ownerHash");
	const page = safeInteger(value, "page");
	const nextPage = safeInteger(value, "nextPage");
	const nextCursor = value["nextCursor"];
	if (
		!archiveId ||
		!ARCHIVE_ID_PATTERN.test(archiveId) ||
		!ownerHash ||
		!CSRF_TOKEN_PATTERN.test(ownerHash) ||
		page === null ||
		page < 0 ||
		nextPage === null ||
		nextPage !== page + 1 ||
		!isPublisherArchiveKind(value["kind"]) ||
		(nextCursor !== null && typeof nextCursor !== "string") ||
		typeof value["replayed"] !== "boolean" ||
		typeof value["complete"] !== "boolean" ||
		typeof value["manifestWritten"] !== "boolean" ||
		value["complete"] !== (nextCursor === null) ||
		(value["manifestWritten"] && !value["complete"])
	) {
		throw invalidResponse();
	}
	return {
		archiveId,
		ownerHash,
		page,
		kind: value["kind"],
		nextCursor,
		nextPage,
		replayed: value["replayed"],
		complete: value["complete"],
		manifestWritten: value["manifestWritten"],
	};
}

function parseStartedPublisherArchive(value: unknown): StartPublisherArchiveResult {
	if (!isRecord(value)) throw invalidResponse();
	const archiveId = stringValue(value, "archiveId");
	const workflowId = stringValue(value, "workflowId");
	if (
		!archiveId ||
		!ARCHIVE_ID_PATTERN.test(archiveId) ||
		!workflowId ||
		!CSRF_TOKEN_PATTERN.test(workflowId) ||
		typeof value["created"] !== "boolean"
	) {
		throw invalidResponse();
	}
	return { archiveId, workflowId, created: value["created"] };
}

function restorePageInput(value: PublisherRestorePageInput): PublisherRestorePageInput {
	if (
		!ARCHIVE_ID_PATTERN.test(value.archiveId) ||
		!Number.isSafeInteger(value.page) ||
		value.page < 0 ||
		value.page > 999_999
	) {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Publisher restore page is invalid",
		});
	}
	return value;
}

function parsePublisherRestorePage(value: unknown): PublisherRestorePageResult {
	if (!isRecord(value)) throw invalidResponse();
	const archiveId = stringValue(value, "archiveId");
	const ownerHash = stringValue(value, "ownerHash");
	const page = safeInteger(value, "page");
	const nextPage = safeInteger(value, "nextPage");
	const totalPages = safeInteger(value, "totalPages");
	if (
		!archiveId ||
		!ARCHIVE_ID_PATTERN.test(archiveId) ||
		!ownerHash ||
		!CSRF_TOKEN_PATTERN.test(ownerHash) ||
		page === null ||
		page < 0 ||
		nextPage === null ||
		nextPage < page + 1 ||
		totalPages === null ||
		totalPages < 1 ||
		nextPage > totalPages ||
		!isPublisherArchiveKind(value["kind"]) ||
		typeof value["replayed"] !== "boolean" ||
		typeof value["complete"] !== "boolean" ||
		value["authorityStatus"] !== "reauthorization_required" ||
		value["complete"] !== (nextPage === totalPages)
	) {
		throw invalidResponse();
	}
	return {
		archiveId,
		ownerHash,
		page,
		kind: value["kind"],
		nextPage,
		totalPages,
		replayed: value["replayed"],
		complete: value["complete"],
		authorityStatus: "reauthorization_required",
	};
}

function parsePreparedPublisherRestore(value: unknown): PreparePublisherRestoreResult {
	if (!isRecord(value)) throw invalidResponse();
	const archiveId = stringValue(value, "archiveId");
	const publisherDid = stringValue(value, "publisherDid");
	const deletedIntents = safeInteger(value, "deletedIntents");
	const deletedWorkloads = safeInteger(value, "deletedWorkloads");
	if (
		!archiveId ||
		!ARCHIVE_ID_PATTERN.test(archiveId) ||
		!publisherDid ||
		!DID_PATTERN.test(publisherDid) ||
		value["prepared"] !== true ||
		typeof value["replayed"] !== "boolean" ||
		deletedIntents === null ||
		deletedIntents < 0 ||
		deletedWorkloads === null ||
		deletedWorkloads < 0
	) {
		throw invalidResponse();
	}
	return {
		archiveId,
		publisherDid,
		prepared: true,
		deletedIntents,
		deletedWorkloads,
		replayed: value["replayed"],
	};
}

function parseAbortedPublisherRestore(value: unknown): AbortPublisherRestoreResult {
	if (!isRecord(value)) throw invalidResponse();
	const archiveId = stringValue(value, "archiveId");
	const publisherDid = stringValue(value, "publisherDid");
	if (
		!archiveId ||
		!ARCHIVE_ID_PATTERN.test(archiveId) ||
		!publisherDid ||
		!DID_PATTERN.test(publisherDid) ||
		value["aborted"] !== true ||
		typeof value["replayed"] !== "boolean"
	) {
		throw invalidResponse();
	}
	return {
		archiveId,
		publisherDid,
		aborted: true,
		replayed: value["replayed"],
	};
}

export class ReleaseServiceOperatorClient extends BaseReleaseServiceClient {
	#mutationHeaders(idempotencyKey: string): Headers {
		return new Headers({
			"content-type": "application/json",
			"idempotency-key": requireIdempotencyKey(idempotencyKey),
			"x-emdash-request": "1",
		});
	}

	async getStatus(options: RequestOptions = {}): Promise<ServiceControlState> {
		return await this.call(
			"/admin/api/status",
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseServiceState(value["state"]);
			},
		);
	}

	async getEncryptionKeyStatus(options: RequestOptions = {}): Promise<EncryptionKeyStatusResource> {
		return await this.call(
			"/admin/api/encryption/keys",
			{ method: "GET", credentials: "include", signal: options.signal },
			parseEncryptionKeyStatus,
		);
	}

	async activateEncryptionKey(
		version: number,
		options: MutationOptions,
	): Promise<MutationResult<EncryptionKeyStateResource>> {
		if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Encryption key version is invalid",
			});
		}
		return await this.call(
			"/admin/api/encryption/keys/activate",
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ version }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parseEncryptionKeyState(value["key"]), replayed: value["replayed"] };
			},
		);
	}

	async startEncryptionVerification(
		retiringVersion: number,
		options: MutationOptions,
	): Promise<StartEncryptionVerificationResult> {
		if (
			!Number.isSafeInteger(retiringVersion) ||
			retiringVersion < 1 ||
			retiringVersion > 2_147_483_647
		) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Retiring encryption key version is invalid",
			});
		}
		return await this.call(
			"/admin/api/encryption/verify",
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ retiringVersion }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["created"] !== "boolean") {
					throw invalidResponse();
				}
				const workflowId = stringValue(value, "workflowId");
				if (!workflowId || !DIGEST_PATTERN.test(workflowId)) throw invalidResponse();
				return { workflowId, created: value["created"] };
			},
		);
	}

	async retireEncryptionKey(
		version: number,
		options: MutationOptions,
	): Promise<MutationResult<EncryptionKeyStateResource>> {
		if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Encryption key version is invalid",
			});
		}
		return await this.call(
			`/admin/api/encryption/keys/${version}/retire`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parseEncryptionKeyState(value["key"]), replayed: value["replayed"] };
			},
		);
	}

	async listDirectory(
		kind: DirectoryIdentityKind,
		options: DirectoryListOptions & RequestOptions = {},
	): Promise<CursorPage<DirectoryIdentityResource>> {
		if (
			(kind !== "approver" && kind !== "publisher") ||
			(options.cursor !== undefined && options.cursor.length === 0) ||
			(options.limit !== undefined &&
				(!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100))
		) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Directory list request is invalid",
			});
		}
		const url = new URL("/admin/api/directory", this.serviceUrl);
		url.searchParams.set("kind", kind);
		if (options.cursor !== undefined) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, parseDirectoryIdentity),
		);
	}

	async listAudit(options: AuditListOptions = {}): Promise<CursorPage<ControlAuditEventResource>> {
		const url = new URL("/admin/api/audit", this.serviceUrl);
		if (options.cursor) {
			if (!DIGITS_PATTERN.test(options.cursor)) {
				throw new ReleaseServiceError({
					code: "CLIENT_RESPONSE_INVALID",
					message: "Audit cursor is invalid",
				});
			}
			url.searchParams.set("after", options.cursor);
		}
		if (options.limit !== undefined) {
			if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
				throw new ReleaseServiceError({
					code: "CLIENT_RESPONSE_INVALID",
					message: "Audit limit is invalid",
				});
			}
			url.searchParams.set("limit", String(options.limit));
		}
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include" },
			(value) => {
				if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
				const nextCursor = nullableString(value, "nextCursor");
				if (nextCursor === undefined) throw invalidResponse();
				return {
					items: value["items"].map(parseControlAuditEvent),
					...(nextCursor ? { nextCursor } : {}),
				};
			},
		);
	}

	async setMode(
		mode: ServiceControlState["mode"],
		reasonCode: string | null,
		options: MutationOptions,
	): Promise<MutationResult<ServiceControlState>> {
		return await this.call(
			"/admin/api/pause",
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ mode, reasonCode }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parseServiceState(value["state"]), replayed: value["replayed"] };
			},
		);
	}

	async getPublisher(
		publisherDid: string,
		options: RequestOptions = {},
	): Promise<OperatorPublisherResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value) || !isRecord(value["publisher"])) throw invalidResponse();
				const publisher = parsePublisher(value["publisher"]);
				return { ...publisher, control: parsePublisherControl(value["publisher"]["control"]) };
			},
		);
	}

	async setPublisherSuspended(
		publisherDid: string,
		suspended: boolean,
		reasonCode: string | null,
		options: MutationOptions,
	): Promise<PublisherControlResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/suspend`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ suspended, reasonCode }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || !isRecord(value["publisher"])) throw invalidResponse();
				return parsePublisherControl(value["publisher"]["control"]);
			},
		);
	}

	async revokePublisher(
		publisherDid: string,
		options: MutationOptions,
	): Promise<PublisherResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/revoke`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async archivePublisher(
		publisherDid: string,
		page: PublisherArchivePageInput,
		options: MutationOptions,
	): Promise<PublisherArchivePageResult> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/archive`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify(archivePageInput(page)),
				signal: options.signal,
			},
			parsePublisherArchivePage,
		);
	}

	async startPublisherArchive(
		publisherDid: string,
		archiveId: string,
		options: MutationOptions,
	): Promise<StartPublisherArchiveResult> {
		if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Publisher archive ID is invalid",
			});
		}
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/archive/start`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ archiveId }),
				signal: options.signal,
			},
			parseStartedPublisherArchive,
		);
	}

	async restorePublisher(
		publisherDid: string,
		page: PublisherRestorePageInput,
		options: MutationOptions,
	): Promise<PublisherRestorePageResult> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/restore`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify(restorePageInput(page)),
				signal: options.signal,
			},
			parsePublisherRestorePage,
		);
	}

	async preparePublisherRestore(
		publisherDid: string,
		archiveId: string,
		options: MutationOptions,
	): Promise<PreparePublisherRestoreResult> {
		if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Publisher archive ID is invalid",
			});
		}
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/restore/prepare`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ archiveId, confirmPublisherDid: publisherDid }),
				signal: options.signal,
			},
			parsePreparedPublisherRestore,
		);
	}

	async abortPublisherRestore(
		publisherDid: string,
		archiveId: string,
		options: MutationOptions,
	): Promise<AbortPublisherRestoreResult> {
		if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
			throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Publisher archive ID is invalid",
			});
		}
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/restore/abort`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ archiveId, confirmPublisherDid: publisherDid }),
				signal: options.signal,
			},
			parseAbortedPublisherRestore,
		);
	}

	async rotatePublisherEncryption(
		publisherDid: string,
		page: EncryptionRotationPageInput,
		options: MutationOptions,
	): Promise<EncryptionRotationResult> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/encryption/rotate`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify(rotationPageInput(page)),
				signal: options.signal,
			},
			parseEncryptionRotation,
		);
	}

	async rotateApproverEncryption(
		approverDid: string,
		page: EncryptionRotationPageInput,
		options: MutationOptions,
	): Promise<EncryptionRotationResult> {
		return await this.call(
			`/admin/api/approvers/${encodeURIComponent(approverDid)}/encryption/rotate`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify(rotationPageInput(page)),
				signal: options.signal,
			},
			parseEncryptionRotation,
		);
	}

	async cancelIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<ReleaseIntentResource> {
		return await this.call(
			`/admin/api/intents/${encodeURIComponent(intentId)}/cancel`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ publisherDid }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async reconcileIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<{ intent: ReleaseIntentResource; restarted: boolean }> {
		return await this.call(
			`/admin/api/intents/${encodeURIComponent(intentId)}/reconcile`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ publisherDid }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["restarted"] !== "boolean") {
					throw invalidResponse();
				}
				return {
					intent: parseIntent(value["intent"], this.serviceUrl),
					restarted: value["restarted"],
				};
			},
		);
	}
}

export type ReleaseRecord = PackageRelease.Main;
