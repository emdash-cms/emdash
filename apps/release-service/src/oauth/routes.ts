import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";

import { isRecord, readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import { createApproverApplicationSession } from "../approver-session/session.js";
import type { ServiceConfiguration } from "../config.js";
import { registerDirectoryIdentity } from "../directory/sharding.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import {
	PublisherSessionError,
	clearOAuthRouteCookie,
	createOAuthRouteCookie,
	createPublisherApplicationSession,
	readOAuthRouteCookie,
	requirePublisherApplicationSession,
} from "../publisher-session/session.js";
import {
	createApproverOAuthClient,
	createPublisherOAuthClient,
	createWorkerActorResolver,
	canonicalizeRedirectTarget,
} from "./custody.js";

const OAUTH_NETWORK_TIMEOUT_MS = 30_000;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface OAuthRouteDependencies {
	registerDirectoryIdentity?: typeof registerDirectoryIdentity;
}

export async function handleApproverIdentityAuthorize(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		requireSameOriginRequest(request, configuration.publicOrigin);
		const body = await readJsonObject(request);
		if (
			Object.keys(body).length !== 2 ||
			typeof body["identifier"] !== "string" ||
			(!isDid(body["identifier"]) && !isHandle(body["identifier"])) ||
			typeof body["redirectTarget"] !== "string"
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid OAuth authorization request");
		}
		const redirectTarget = canonicalizeRedirectTarget(
			body["redirectTarget"],
			configuration.publicOrigin,
		);
		const actorResolver = createWorkerActorResolver();
		const actor = await actorResolver.resolve(body["identifier"], {
			signal: AbortSignal.timeout(30_000),
		});
		const client = createApproverOAuthClient({
			namespace: env.APPROVER_DO,
			encryption: configuration.encryption,
			oauth: configuration.oauth,
			flow: {
				purpose: "approver_identity",
				expectedDid: actor.did,
				redirectTarget,
			},
			actorResolver,
		});
		const authorization = await client.authorize(
			{ type: "account", identifier: actor.did },
			{ signal: AbortSignal.timeout(30_000) },
		);
		return redirectToAuthorization(
			request,
			authorization.url,
			createOAuthRouteCookie({
				purpose: "approver_identity",
				expectedDid: actor.did,
				redirectTarget,
				stateId: authorization.stateId,
			}),
			requestId,
		);
	} catch (error) {
		if (error instanceof ApiError) return apiFailure(error, requestId);
		return oauthError(
			"OAUTH_AUTHORIZATION_FAILED",
			400,
			"OAuth authorization could not be started",
			requestId,
		);
	}
}

function oauthError(
	code: "OAUTH_AUTHORIZATION_FAILED" | "OAUTH_CALLBACK_INVALID",
	status: number,
	message: string,
	requestId: string,
	clearRouteCookie = false,
): Response {
	const response = apiFailure(new ApiError(code, status, message), requestId);
	if (!clearRouteCookie) return response;
	const headers = new Headers(response.headers);
	headers.append("set-cookie", clearOAuthRouteCookie());
	return new Response(response.body, { status: response.status, headers });
}

function logOAuthError(event: string, requestId: string, error: unknown): void {
	const name =
		error instanceof Error && ERROR_NAME_PATTERN.test(error.name) ? error.name : "UnknownError";
	const candidateCode =
		isRecord(error) && typeof error["code"] === "string"
			? error["code"]
			: isRecord(error) && typeof error["error"] === "string"
				? error["error"]
				: undefined;
	const errorCode =
		candidateCode && ERROR_CODE_PATTERN.test(candidateCode) ? candidateCode : undefined;
	console.error(
		JSON.stringify({
			event,
			requestId,
			error: { name, ...(errorCode ? { code: errorCode } : {}) },
		}),
	);
}

const callbackFetch: typeof fetch = (input, init) =>
	globalThis.fetch(input, {
		...init,
		signal: init?.signal ?? AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
	});

function requireSameOriginRequest(request: Request, publicOrigin: string): void {
	if (
		request.headers.get("origin") !== publicOrigin ||
		request.headers.get("x-emdash-request") !== "1"
	) {
		throw new ApiError("CSRF_INVALID", 403, "Request origin could not be verified");
	}
}

function redirectToAuthorization(
	request: Request,
	url: URL,
	stateCookie: string,
	requestId: string,
): Response {
	if (
		request.headers
			.get("accept")
			?.split(",")
			.some((value) => value.trim() === "application/json")
	) {
		const response = apiSuccess({ authorizationUrl: url.toString() }, requestId);
		const headers = new Headers(response.headers);
		headers.append("set-cookie", stateCookie);
		return new Response(response.body, { status: response.status, headers });
	}
	const headers = new Headers({
		"cache-control": "no-store",
		location: url.toString(),
		"x-content-type-options": "nosniff",
		"x-request-id": requestId,
	});
	headers.append("set-cookie", stateCookie);
	return new Response(null, { status: 303, headers });
}

export async function handlePublisherIdentityAuthorize(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		requireSameOriginRequest(request, configuration.publicOrigin);
		const body = await readJsonObject(request);
		if (
			Object.keys(body).length !== 2 ||
			typeof body["identifier"] !== "string" ||
			(!isDid(body["identifier"]) && !isHandle(body["identifier"])) ||
			typeof body["redirectTarget"] !== "string"
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid OAuth authorization request");
		}
		const redirectTarget = canonicalizeRedirectTarget(
			body["redirectTarget"],
			configuration.publicOrigin,
		);
		const actorResolver = createWorkerActorResolver();
		const actor = await actorResolver.resolve(body["identifier"], {
			signal: AbortSignal.timeout(30_000),
		});
		const client = createPublisherOAuthClient({
			namespace: env.PUBLISHER_DO,
			encryption: configuration.encryption,
			oauth: configuration.oauth,
			flow: {
				purpose: "publisher_identity",
				expectedDid: actor.did,
				redirectTarget,
			},
			actorResolver,
		});
		const authorization = await client.authorize(
			{ type: "account", identifier: actor.did },
			{ signal: AbortSignal.timeout(30_000) },
		);
		return redirectToAuthorization(
			request,
			authorization.url,
			createOAuthRouteCookie({
				purpose: "publisher_identity",
				expectedDid: actor.did,
				redirectTarget,
				stateId: authorization.stateId,
			}),
			requestId,
		);
	} catch (error) {
		if (error instanceof ApiError) return apiFailure(error, requestId);
		return oauthError(
			"OAUTH_AUTHORIZATION_FAILED",
			400,
			"OAuth authorization could not be started",
			requestId,
		);
	}
}

export async function handlePublisherDelegationAuthorize(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await requirePublisherApplicationSession(
			request,
			env.PUBLISHER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const body = await readJsonObject(request);
		if (Object.keys(body).length !== 1 || typeof body["redirectTarget"] !== "string") {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid delegation authorization request");
		}
		const redirectTarget = canonicalizeRedirectTarget(
			body["redirectTarget"],
			configuration.publicOrigin,
		);
		if (!isDid(session.publisherDid)) {
			throw new ApiError("PUBLISHER_SESSION_INVALID", 401, "Publisher session is not valid");
		}
		const client = createPublisherOAuthClient({
			namespace: env.PUBLISHER_DO,
			encryption: configuration.encryption,
			oauth: configuration.oauth,
			flow: {
				purpose: "release_delegation",
				expectedDid: session.publisherDid,
				redirectTarget,
			},
		});
		const authorization = await client.authorize(
			{ type: "account", identifier: session.publisherDid },
			{ signal: AbortSignal.timeout(30_000) },
		);
		return redirectToAuthorization(
			request,
			authorization.url,
			createOAuthRouteCookie({
				purpose: "release_delegation",
				expectedDid: session.publisherDid,
				redirectTarget,
				stateId: authorization.stateId,
			}),
			requestId,
		);
	} catch (error) {
		if (error instanceof ApiError) return apiFailure(error, requestId);
		if (error instanceof PublisherSessionError) {
			const suspended = error.code === "PUBLISHER_SUSPENDED";
			return apiFailure(
				new ApiError(
					suspended ? "PUBLISHER_SUSPENDED" : "PUBLISHER_SESSION_INVALID",
					suspended ? 403 : 401,
					"Publisher session is not valid",
				),
				requestId,
			);
		}
		return oauthError(
			"OAUTH_AUTHORIZATION_FAILED",
			400,
			"OAuth authorization could not be started",
			requestId,
		);
	}
}

export async function handleOAuthCallback(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: OAuthRouteDependencies = {},
): Promise<Response> {
	try {
		const params = new URL(request.url).searchParams;
		const state = params.get("state");
		if (!state) throw new ApiError("OAUTH_CALLBACK_INVALID", 400, "OAuth callback is invalid");
		const route = readOAuthRouteCookie(request, state);
		if (route.purpose === "release_delegation") {
			const publisherSession = await requirePublisherApplicationSession(
				request,
				env.PUBLISHER_DO,
				configuration.publicOrigin,
			);
			if (publisherSession.publisherDid !== route.expectedDid) {
				throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
			}
		}
		const client =
			route.purpose === "approver_identity"
				? createApproverOAuthClient({
						namespace: env.APPROVER_DO,
						encryption: configuration.encryption,
						oauth: configuration.oauth,
						flow: {
							purpose: "approver_identity",
							expectedDid: route.expectedDid,
							redirectTarget: route.redirectTarget,
						},
						fetch: callbackFetch,
					})
				: createPublisherOAuthClient({
						namespace: env.PUBLISHER_DO,
						encryption: configuration.encryption,
						oauth: configuration.oauth,
						flow: {
							purpose: route.purpose,
							expectedDid: route.expectedDid,
							redirectTarget: route.redirectTarget,
						},
						fetch: callbackFetch,
					});
		const identityKinds =
			route.purpose === "release_delegation"
				? (["publisher"] as const)
				: (["publisher", "approver"] as const);
		const register = dependencies.registerDirectoryIdentity ?? registerDirectoryIdentity;
		const registerIdentities = async () => {
			for (const identityKind of identityKinds) {
				try {
					await register(identityKind, route.expectedDid);
				} catch (error) {
					writeOperationsMetric({
						event: "directory_failure",
						outcome: identityKind,
						requestId,
					});
					console.error(
						JSON.stringify({
							event: "identity_directory_registration_failed",
							requestId,
							name: error instanceof Error ? error.name : "UnknownError",
						}),
					);
					throw error;
				}
			}
		};
		if (route.purpose === "release_delegation") await registerIdentities();
		await client.callback(params);
		if (route.purpose !== "release_delegation") await registerIdentities();
		const headers = new Headers({
			"cache-control": "no-store",
			location: new URL(route.redirectTarget, configuration.publicOrigin).toString(),
			"x-content-type-options": "nosniff",
			"x-request-id": requestId,
		});
		headers.append("set-cookie", clearOAuthRouteCookie());
		if (route.purpose !== "release_delegation") {
			if (route.purpose === "publisher_identity") await client.revoke();
			const [publisherSession, approverSession] = await Promise.all([
				createPublisherApplicationSession(env.PUBLISHER_DO, route.expectedDid),
				createApproverApplicationSession(env.APPROVER_DO, route.expectedDid),
			]);
			for (const cookie of publisherSession.setCookieHeaders) headers.append("set-cookie", cookie);
			for (const cookie of approverSession.setCookieHeaders) headers.append("set-cookie", cookie);
		}
		return new Response(null, { status: 303, headers });
	} catch (error) {
		logOAuthError("oauth_callback_error", requestId, error);
		return oauthError(
			"OAUTH_CALLBACK_INVALID",
			400,
			"OAuth callback could not be validated",
			requestId,
			true,
		);
	}
}
