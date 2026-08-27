import type { PackageRelease } from "@emdash-cms/registry-lexicons";

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
	| "AUTH_INVALID"
	| "CONFIGURATION_ERROR"
	| "CREDENTIAL_LIMIT_REACHED"
	| "CREDENTIAL_NOT_FOUND"
	| "CREDENTIAL_REVOKED"
	| "CSRF_INVALID"
	| "DELEGATION_REQUIRED"
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
	| "PROFILE_CHANGED"
	| "PROFILE_FETCH_FAILED"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SUSPENDED"
	| "RELEASE_EXISTS"
	| "SERVICE_PAUSED"
	| "SERVICE_UNAVAILABLE"
	| "VERSION_RESERVED"
	| "WORKFLOW_UNAVAILABLE"
	| "WORKLOAD_NOT_ALLOWED";

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
	release: PackageRelease.Main;
}

export interface SubmitReleaseIntentResult {
	intent: ReleaseIntentResource;
	replayed: boolean;
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
