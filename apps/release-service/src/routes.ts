import type { AccessActor, AccessRole } from "./access/auth.js";
import {
	handleBeginApprovalDecision,
	handleCompleteApprovalDecision,
	handleGetApproval,
	matchApprovalOptionsPath,
	matchApprovalResourcePath,
} from "./approvals/decision-routes.js";
import {
	handleBeginApproverCredentialRegistration,
	handleCompleteApproverCredentialRegistration,
	handleListApproverCredentials,
	handleRevokeApproverCredential,
	matchApproverCredentialPath,
} from "./approvals/routes.js";
import {
	handleAbortPublisherRestore,
	handleArchivePublisher,
	handlePreparePublisherRestore,
	handleRestorePublisher,
	matchPublisherArchivePath,
	matchPublisherRestoreAbortPath,
	matchPublisherRestorePreparePath,
	matchPublisherRestorePath,
} from "./backup/routes.js";
import {
	handleStartPublisherArchive,
	matchPublisherArchiveStartPath,
} from "./backup/workflow-route.js";
import type { ServiceConfiguration } from "./config.js";
import {
	handleActivateEncryptionKey,
	handleControlAudit,
	handleEncryptionKeyStatus,
	handleReadiness,
	handleRetireEncryptionKey,
	handleServiceStatus,
	handleSetServiceMode,
	handleStartEncryptionVerification,
	matchRetireEncryptionKeyPath,
} from "./control-do/routes.js";
import { handleListDirectory } from "./directory/routes.js";
import {
	handleCancelReleaseIntent,
	handleDryRunReleaseIntent,
	handleGetReleaseIntent,
	handleSubmitReleaseIntent,
	matchIntentCancelPath,
	matchIntentResourcePath,
} from "./intents/routes.js";
import { getClientMetadata, getPublicJwks, publicOAuthJson } from "./oauth/metadata.js";
import {
	handleApproverIdentityAuthorize,
	handleOAuthCallback,
	handlePublisherDelegationAuthorize,
	handlePublisherIdentityAuthorize,
} from "./oauth/routes.js";
import {
	handleRotateApproverEncryption,
	handleRotatePublisherEncryption,
	matchApproverEncryptionRotationPath,
	matchPublisherEncryptionRotationPath,
} from "./operations/encryption-routes.js";
import {
	handleCancelOperatorIntent,
	handleGetOperatorPublisher,
	handleReconcileOperatorIntent,
	handleRevokeOperatorPublisher,
	handleSetOperatorPublisherSuspension,
	matchOperatorIntentCancelPath,
	matchOperatorIntentReconcilePath,
	matchOperatorPublisherPath,
	matchOperatorPublisherRevokePath,
	matchOperatorPublisherSuspendPath,
} from "./operator/routes.js";
import {
	handleDisablePublisherWorkload,
	handleGetPublisherApproverStatus,
	handleGetPublisher,
	handleListPublisherAudit,
	handleListPublisherIntents,
	handleListPublisherWorkloads,
	handlePutPublisherWorkload,
	handleRevokePublisherDelegation,
	matchPublisherApproverStatusPath,
	matchPublisherWorkloadPath,
} from "./publisher/routes.js";
import {
	handleGetPublishedProvenance,
	matchPublishedProvenancePath,
} from "./publishing/provenance-routes.js";
import { handleUploadWorkloadArtifact } from "./publishing/workload-staging-routes.js";
import {
	handleConfirmWorkflowConnection,
	handleCreateWorkflowConnectionInvitation,
	handleListWorkflowConnections,
	handleRejectWorkflowConnection,
	handleRequestWorkflowConnection,
	matchWorkflowConnectionConfirmPath,
	matchWorkflowConnectionPath,
} from "./workflow-connection/routes.js";

export interface RouteDefinition {
	method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
	match?(pathname: string): Readonly<Record<string, string>> | null;
	accessRole?: AccessRole;
	handler(
		request: Request,
		requestId: string,
		configuration: ServiceConfiguration,
		params: Readonly<Record<string, string>>,
		accessActor: AccessActor | null,
	): Response | Promise<Response>;
}

export const ROUTES = Object.freeze([
	{
		method: "GET",
		path: "/.well-known/atproto-client-metadata.json",
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getClientMetadata(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/oauth/jwks.json",
		handler: (_request, _requestId, configuration) =>
			publicOAuthJson(getPublicJwks(configuration.oauth)),
	},
	{
		method: "GET",
		path: "/v1/provenance/{checksum}",
		match: matchPublishedProvenancePath,
		handler: (request, requestId, _configuration, params) =>
			handleGetPublishedProvenance(request, requestId, params),
	},
	{
		method: "POST",
		path: "/v1/staged-artifacts",
		handler: (request, requestId, configuration) =>
			handleUploadWorkloadArtifact(request, requestId, configuration),
	},
	{
		method: "POST",
		path: "/v1/release-intents",
		handler: (request, requestId, configuration) =>
			handleSubmitReleaseIntent(request, requestId, configuration),
	},
	{
		method: "POST",
		path: "/v1/release-intents/dry-run",
		handler: (request, requestId, configuration) =>
			handleDryRunReleaseIntent(request, requestId, configuration),
	},
	{
		method: "GET",
		path: "/v1/release-intents/{intentId}",
		match: matchIntentResourcePath,
		handler: (request, requestId, configuration, params) =>
			handleGetReleaseIntent(request, requestId, configuration, params),
	},
	{
		method: "POST",
		path: "/v1/release-intents/{intentId}/cancel",
		match: matchIntentCancelPath,
		handler: (request, requestId, configuration, params) =>
			handleCancelReleaseIntent(request, requestId, configuration, params),
	},
	{
		method: "POST",
		path: "/v1/publisher/session/authorize",
		handler: handlePublisherIdentityAuthorize,
	},
	{
		method: "GET",
		path: "/v1/publisher",
		handler: (request, requestId, configuration) =>
			handleGetPublisher(request, requestId, configuration),
	},
	{
		method: "DELETE",
		path: "/v1/publisher/delegation",
		handler: (request, requestId, configuration) =>
			handleRevokePublisherDelegation(request, requestId, configuration),
	},
	{
		method: "GET",
		path: "/v1/publisher/workloads",
		handler: handleListPublisherWorkloads,
	},
	{
		method: "POST",
		path: "/v1/workflow-connections",
		handler: (request, requestId, configuration) =>
			handleRequestWorkflowConnection(request, requestId, configuration),
	},
	{
		method: "GET",
		path: "/v1/publisher/workflow-connections",
		handler: (request, requestId, configuration) =>
			handleListWorkflowConnections(request, requestId, configuration),
	},
	{
		method: "POST",
		path: "/v1/publisher/workflow-connection-invitations",
		handler: (request, requestId, configuration) =>
			handleCreateWorkflowConnectionInvitation(request, requestId, configuration),
	},
	{
		method: "POST",
		path: "/v1/publisher/workflow-connections/{requestId}/confirm",
		match: matchWorkflowConnectionConfirmPath,
		handler: (request, requestId, configuration, params) =>
			handleConfirmWorkflowConnection(request, requestId, configuration, params),
	},
	{
		method: "DELETE",
		path: "/v1/publisher/workflow-connections/{requestId}",
		match: matchWorkflowConnectionPath,
		handler: (request, requestId, configuration, params) =>
			handleRejectWorkflowConnection(request, requestId, configuration, params),
	},
	{
		method: "POST",
		path: "/v1/publisher/workloads",
		handler: handlePutPublisherWorkload,
	},
	{
		method: "DELETE",
		path: "/v1/publisher/workloads/{packageSlug}",
		match: matchPublisherWorkloadPath,
		handler: handleDisablePublisherWorkload,
	},
	{
		method: "GET",
		path: "/v1/publisher/workloads/{packageSlug}/approvers",
		match: matchPublisherApproverStatusPath,
		handler: (request, requestId, configuration, params) =>
			handleGetPublisherApproverStatus(request, requestId, configuration, params),
	},
	{
		method: "GET",
		path: "/v1/publisher/intents",
		handler: handleListPublisherIntents,
	},
	{
		method: "GET",
		path: "/v1/publisher/audit",
		handler: handleListPublisherAudit,
	},
	{
		method: "POST",
		path: "/v1/approver/session/authorize",
		handler: handleApproverIdentityAuthorize,
	},
	{
		method: "GET",
		path: "/v1/approver/credentials",
		handler: handleListApproverCredentials,
	},
	{
		method: "POST",
		path: "/v1/approver/credentials/options",
		handler: handleBeginApproverCredentialRegistration,
	},
	{
		method: "POST",
		path: "/v1/approver/credentials",
		handler: handleCompleteApproverCredentialRegistration,
	},
	{
		method: "DELETE",
		path: "/v1/approver/credentials/{credentialId}",
		match: matchApproverCredentialPath,
		handler: handleRevokeApproverCredential,
	},
	{
		method: "GET",
		path: "/v1/approvals/{intentId}",
		match: matchApprovalResourcePath,
		handler: handleGetApproval,
	},
	{
		method: "POST",
		path: "/v1/approvals/{intentId}/options",
		match: matchApprovalOptionsPath,
		handler: handleBeginApprovalDecision,
	},
	{
		method: "POST",
		path: "/v1/approvals/{intentId}",
		match: matchApprovalResourcePath,
		handler: handleCompleteApprovalDecision,
	},
	{
		method: "POST",
		path: "/v1/publisher/delegation/authorize",
		handler: handlePublisherDelegationAuthorize,
	},
	{
		method: "GET",
		path: "/oauth/callback",
		handler: handleOAuthCallback,
	},
	{
		method: "GET",
		path: "/ready",
		handler: handleReadiness,
	},
	{
		method: "GET",
		path: "/admin/api/status",
		accessRole: "viewer",
		handler: handleServiceStatus,
	},
	{
		method: "GET",
		path: "/admin/api/directory",
		accessRole: "viewer",
		handler: handleListDirectory,
	},
	{
		method: "POST",
		path: "/admin/api/pause",
		accessRole: "admin",
		handler: handleSetServiceMode,
	},
	{
		method: "GET",
		path: "/admin/api/publishers/{publisherDid}",
		match: matchOperatorPublisherPath,
		accessRole: "viewer",
		handler: handleGetOperatorPublisher,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/suspend",
		match: matchOperatorPublisherSuspendPath,
		accessRole: "admin",
		handler: handleSetOperatorPublisherSuspension,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/revoke",
		match: matchOperatorPublisherRevokePath,
		accessRole: "admin",
		handler: handleRevokeOperatorPublisher,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/encryption/rotate",
		match: matchPublisherEncryptionRotationPath,
		accessRole: "admin",
		handler: handleRotatePublisherEncryption,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/archive",
		match: matchPublisherArchivePath,
		accessRole: "admin",
		handler: handleArchivePublisher,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/archive/start",
		match: matchPublisherArchiveStartPath,
		accessRole: "admin",
		handler: handleStartPublisherArchive,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/restore",
		match: matchPublisherRestorePath,
		accessRole: "admin",
		handler: handleRestorePublisher,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/restore/prepare",
		match: matchPublisherRestorePreparePath,
		accessRole: "admin",
		handler: handlePreparePublisherRestore,
	},
	{
		method: "POST",
		path: "/admin/api/publishers/{publisherDid}/restore/abort",
		match: matchPublisherRestoreAbortPath,
		accessRole: "admin",
		handler: handleAbortPublisherRestore,
	},
	{
		method: "POST",
		path: "/admin/api/approvers/{approverDid}/encryption/rotate",
		match: matchApproverEncryptionRotationPath,
		accessRole: "admin",
		handler: handleRotateApproverEncryption,
	},
	{
		method: "POST",
		path: "/admin/api/intents/{intentId}/cancel",
		match: matchOperatorIntentCancelPath,
		accessRole: "reviewer",
		handler: handleCancelOperatorIntent,
	},
	{
		method: "POST",
		path: "/admin/api/intents/{intentId}/reconcile",
		match: matchOperatorIntentReconcilePath,
		accessRole: "reviewer",
		handler: handleReconcileOperatorIntent,
	},
	{
		method: "GET",
		path: "/admin/api/audit",
		accessRole: "viewer",
		handler: handleControlAudit,
	},
	{
		method: "GET",
		path: "/admin/api/encryption/keys",
		accessRole: "viewer",
		handler: handleEncryptionKeyStatus,
	},
	{
		method: "POST",
		path: "/admin/api/encryption/keys/activate",
		accessRole: "admin",
		handler: handleActivateEncryptionKey,
	},
	{
		method: "POST",
		path: "/admin/api/encryption/verify",
		accessRole: "admin",
		handler: handleStartEncryptionVerification,
	},
	{
		method: "POST",
		path: "/admin/api/encryption/keys/{version}/retire",
		match: matchRetireEncryptionKeyPath,
		accessRole: "admin",
		handler: handleRetireEncryptionKey,
	},
] as const satisfies readonly RouteDefinition[]);
