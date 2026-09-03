import type { DelegatedReleaseSourceRecord } from "./source-record.js";

export type ReleaseIntentState =
	| "received"
	| "verifying"
	| "verified"
	| "awaiting_approval"
	| "ready"
	| "publishing"
	| "reconciling"
	| "published"
	| "invalid"
	| "rejected"
	| "cancelled"
	| "expired"
	| "failed"
	| "conflict";

export type ReleaseServiceApiErrorCode =
	| "ACCESS_DENIED"
	| "ACCESS_AUTH_INVALID"
	| "ACCESS_AUTH_REQUIRED"
	| "APPROVAL_INVALID"
	| "APPROVER_SESSION_INVALID"
	| "APPROVER_SUSPENDED"
	| "ARCHIVE_OPERATION_FAILED"
	| "AUTH_INVALID"
	| "CONFIGURATION_ERROR"
	| "CREDENTIAL_LIMIT_REACHED"
	| "CREDENTIAL_NOT_FOUND"
	| "CREDENTIAL_REVOKED"
	| "CSRF_INVALID"
	| "DELEGATION_REQUIRED"
	| "ENCRYPTION_OPERATION_FAILED"
	| "IDEMPOTENCY_KEY_INVALID"
	| "IDEMPOTENCY_CONFLICT"
	| "INTERNAL_ERROR"
	| "INVALID_REQUEST"
	| "INTENT_NOT_APPROVABLE"
	| "INTENT_NOT_CANCELLABLE"
	| "METHOD_NOT_ALLOWED"
	| "NOT_FOUND"
	| "OAUTH_AUTHORIZATION_FAILED"
	| "OAUTH_CALLBACK_INVALID"
	| "PACKAGE_PROFILE_REQUIRED"
	| "PROFILE_CHANGED"
	| "PROFILE_FETCH_FAILED"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SUSPENDED"
	| "RELEASE_EXISTS"
	| "RESTORE_OPERATION_FAILED"
	| "SERVICE_PAUSED"
	| "SERVICE_UNAVAILABLE"
	| "VERSION_RESERVED"
	| "WORKFLOW_UNAVAILABLE"
	| "WORKFLOW_CONNECTION_CONFLICT"
	| "WORKFLOW_CONNECTION_EXPIRED"
	| "WORKFLOW_CONNECTION_INVITATION_EXPIRED"
	| "WORKFLOW_CONNECTION_INVITATION_INVALID"
	| "WORKFLOW_CONNECTION_INVITATION_LIMIT_REACHED"
	| "WORKFLOW_CONNECTION_INVITATION_REQUIRED"
	| "WORKFLOW_CONNECTION_LIMIT_REACHED"
	| "WORKFLOW_CONNECTION_NOT_FOUND"
	| "WORKLOAD_NOT_ALLOWED"
	| "WORKLOAD_RATE_LIMITED";

export type ReleaseServiceClientErrorCode =
	| ReleaseServiceApiErrorCode
	| "CLIENT_RESPONSE_INVALID"
	| "NETWORK_ERROR"
	| "POLL_TIMEOUT";

export interface ReleaseIntentResult {
	uri: string;
	cid: string;
}

export interface ReleaseIntentResource {
	id: string;
	publisherDid: string;
	packageSlug: string;
	version: string;
	state: ReleaseIntentState;
	stateGeneration: number;
	reasonCode: string | null;
	workflowId: string | null;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
	result: ReleaseIntentResult | null;
	approvalUrl: string | null;
}

export interface SubmitReleaseIntentInput {
	publisherDid: string;
	packageSlug: string;
	version: string;
	release: DelegatedReleaseSourceRecord;
}

export interface SubmitReleaseIntentResult {
	intent: ReleaseIntentResource;
	replayed: boolean;
}

export type ReleaseArtifactSlot =
	| "package"
	| "icon"
	| "banner"
	| `screenshots[${number}]`
	| "provenance";

export interface UploadReleaseArtifactInput {
	publisherDid: string;
	packageSlug: string;
	version: string;
	slot: ReleaseArtifactSlot;
	checksum: string;
	contentType: string;
	bytes: Uint8Array;
}

export interface StagedReleaseArtifactResource {
	slot: ReleaseArtifactSlot;
	checksum: string;
	contentType: string;
	size: number;
	sourceUrl: string;
}

export interface UploadReleaseArtifactResult {
	artifact: StagedReleaseArtifactResource;
	replayed: boolean;
}

export interface DryRunReleaseIntentResult {
	allowed: true;
	publisherDid: string;
	packageSlug: string;
	version: string;
	workloadPolicyVersion: number;
	workloadIdentityDigest: string;
	requestDigest: string;
}

export interface WorkloadPolicyResource {
	packageSlug: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	allowedRefs: readonly string[];
	allowedEnvironments: readonly string[];
	active: boolean;
	stateVersion: number;
	authorizedBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface PutWorkloadPolicyInput {
	packageSlug: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	allowedRefs: readonly string[];
	allowedEnvironments: readonly string[];
	expectedVersion: number | null;
}

export type WorkflowConnectionRequestState = "confirmed" | "expired" | "pending";
export type WorkflowConnectionRefScope = "current_ref" | "version_tags";

export interface WorkflowConnectionClaimResource {
	repository: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryOwnerId: string;
	repositoryVisibility: "internal" | "private" | "public";
	workflowRef: string;
	ref: string;
	environment: string | null;
}

export interface WorkflowConnectionRequestResource {
	id: string;
	packageSlug: string;
	state: WorkflowConnectionRequestState;
	claim: WorkflowConnectionClaimResource;
	refScope: WorkflowConnectionRefScope | null;
	expiresAt: number;
	createdAt: number;
	confirmedAt: number | null;
}

export interface RequestWorkflowConnectionInput {
	publisherDid: string;
	packageSlug: string;
	invitationToken?: string;
}

export interface CreateWorkflowConnectionInvitationResult {
	invitationToken: string;
	packageSlug: string;
	expiresAt: number;
}

export type RequestWorkflowConnectionResult =
	| { status: "connected"; policy: WorkloadPolicyResource }
	| {
			status: "pending";
			request: WorkflowConnectionRequestResource;
			approvalUrl: string;
			replayed: boolean;
	  };

export interface ConfirmWorkflowConnectionResult {
	request: WorkflowConnectionRequestResource;
	policy: WorkloadPolicyResource;
	replayed: boolean;
}

export interface DelegationResource {
	releaseNsid: string;
	scope: string;
	issuer: string | null;
	pdsUrl: string | null;
	expiresAt: number | null;
	refreshBefore: number | null;
	status: "active" | "revoked" | "reauthorization_required";
	stateVersion: number;
}

export interface PublisherResource {
	did: string;
	handle: string | null;
	delegation: DelegationResource | null;
	sessionExpiresAt?: number;
}

export interface ServiceControlState {
	mode: "active" | "admission-paused" | "publication-paused";
	epoch: number;
	reasonCode: string | null;
	changedBy: string;
	changedAt: number;
}

export interface PublisherControlResource {
	publisherDid: string;
	status: "allowed" | "suspended";
	reasonCode: string | null;
	changedBy: string;
	changedAt: number;
}

export interface OperatorPublisherResource extends PublisherResource {
	control: PublisherControlResource;
}

export type DirectoryIdentityKind = "approver" | "publisher";

export interface DirectoryIdentityResource {
	kind: DirectoryIdentityKind;
	did: string;
	shard: string;
	registeredAt: number;
	lastSeenAt: number;
}

export interface DirectoryListOptions {
	cursor?: string;
	limit?: number;
}

export interface AuditListOptions {
	cursor?: string;
	limit?: number;
}

export interface ControlAuditEventResource {
	sequence: number;
	eventType: string;
	actorRealm: "access" | "system";
	actorIdentity: string;
	actorRole: "admin" | "reviewer" | "viewer" | null;
	subject: string;
	reasonCode: string | null;
	createdAt: number;
}

export interface PublisherAuditEventResource {
	sequence: number;
	eventType: string;
	actorRealm: "access" | "approver" | "oidc" | "publisher" | "system";
	actorIdentity: string;
	actorHandle: string | null;
	subject: string;
	reasonCode: string | null;
	createdAt: number;
}

export type PublisherApproverEnrollmentState = "enrolled" | "not_enrolled" | "revoked";

export interface PublisherApproverStatusResource {
	did: string;
	handle: string | null;
	status: PublisherApproverEnrollmentState;
}

export interface PublisherApproverStatusResult {
	packageSlug: string;
	profileCid: string;
	items: PublisherApproverStatusResource[];
}

export interface EncryptionRotationPageInput {
	afterCursor: string | null;
	limit: number;
}

export interface EncryptionRotationResult {
	ownerDid: string;
	targetKeyVersion: number;
	scanned: number;
	rotated: number;
	raced: number;
	nextCursor: string | null;
	complete: boolean;
}

export type EncryptionKeyLifecycleStatus = "active" | "readable" | "retired";

export interface EncryptionKeyStateResource {
	version: number;
	status: EncryptionKeyLifecycleStatus;
	activatedAt: number;
	retiredAt: number | null;
	changedBy: string;
	updatedAt: number;
}

export interface EncryptionKeyStatusResource {
	configured: {
		activeVersion: number;
		versions: number[];
	};
	keys: EncryptionKeyStateResource[];
	verification: EncryptionVerificationResource | null;
}

export interface EncryptionVerificationResource {
	targetKeyVersion: number;
	workflowId: string;
	publishers: number;
	approvers: number;
	records: number;
	rotated: number;
	verifiedAt: number;
}

export interface StartEncryptionVerificationResult {
	workflowId: string;
	created: boolean;
}

export type PublisherArchiveKind = "audit-events" | "intents" | "metadata" | "workload-policies";

export interface PublisherArchivePageInput {
	archiveId: string;
	cursor: string | null;
	page: number;
}

export interface PublisherArchivePageResult {
	archiveId: string;
	ownerHash: string;
	page: number;
	kind: PublisherArchiveKind;
	nextCursor: string | null;
	nextPage: number;
	replayed: boolean;
	complete: boolean;
	manifestWritten: boolean;
}

export interface StartPublisherArchiveResult {
	archiveId: string;
	workflowId: string;
	created: boolean;
}

export interface PublisherRestorePageInput {
	archiveId: string;
	page: number;
}

export interface PublisherRestorePageResult {
	archiveId: string;
	ownerHash: string;
	page: number;
	kind: PublisherArchiveKind;
	nextPage: number;
	totalPages: number;
	replayed: boolean;
	complete: boolean;
	authorityStatus: "reauthorization_required";
}

export interface PreparePublisherRestoreResult {
	archiveId: string;
	publisherDid: string;
	prepared: true;
	deletedIntents: number;
	deletedWorkloads: number;
	replayed: boolean;
}

export interface AbortPublisherRestoreResult {
	archiveId: string;
	publisherDid: string;
	aborted: true;
	replayed: boolean;
}

export interface CursorPage<T> {
	items: T[];
	nextCursor?: string;
}

export interface MutationResult<T> {
	value: T;
	replayed: boolean;
}

export const TERMINAL_RELEASE_INTENT_STATES: ReadonlySet<ReleaseIntentState> = new Set([
	"published",
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict",
]);
