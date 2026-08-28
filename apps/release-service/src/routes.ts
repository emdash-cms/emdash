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
import type { ServiceConfiguration } from "./config.js";
import {
	handleControlAudit,
	handleReadiness,
	handleServiceStatus,
	handleSetServiceMode,
} from "./control-do/routes.js";
import {
	handleCancelReleaseIntent,
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
	handleGetPublisher,
	handleListPublisherIntents,
	handleListPublisherWorkloads,
	handlePutPublisherWorkload,
	handleRevokePublisherDelegation,
	matchPublisherWorkloadPath,
} from "./publisher/routes.js";

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
		method: "POST",
		path: "/v1/release-intents",
		handler: (request, requestId, configuration) =>
			handleSubmitReleaseIntent(request, requestId, configuration),
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
		handler: handleGetPublisher,
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
		path: "/v1/publisher/intents",
		handler: handleListPublisherIntents,
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
] as const satisfies readonly RouteDefinition[]);
