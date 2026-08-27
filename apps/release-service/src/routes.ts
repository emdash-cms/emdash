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
	handleGetPublisherControl,
	handleReadiness,
	handleServiceStatus,
	handleSetPublisherControl,
	handleSetServiceMode,
} from "./control-do/routes.js";
import { getClientMetadata, getPublicJwks, publicOAuthJson } from "./oauth/metadata.js";
import {
	handleApproverIdentityAuthorize,
	handleOAuthCallback,
	handlePublisherDelegationAuthorize,
	handlePublisherIdentityAuthorize,
} from "./oauth/routes.js";

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
		path: "/v1/publisher/session/authorize",
		handler: handlePublisherIdentityAuthorize,
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
		path: "/admin/api/viewer/status",
		accessRole: "viewer",
		handler: handleServiceStatus,
	},
	{
		method: "GET",
		path: "/admin/api/viewer/publisher-control",
		accessRole: "viewer",
		handler: handleGetPublisherControl,
	},
	{
		method: "GET",
		path: "/admin/api/viewer/audit",
		accessRole: "viewer",
		handler: handleControlAudit,
	},
	{
		method: "POST",
		path: "/admin/api/admin/service-mode",
		accessRole: "admin",
		handler: handleSetServiceMode,
	},
	{
		method: "POST",
		path: "/admin/api/admin/publisher-control",
		accessRole: "admin",
		handler: handleSetPublisherControl,
	},
] as const satisfies readonly RouteDefinition[]);
