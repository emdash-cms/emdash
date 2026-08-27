import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";

import { ApiError } from "../api/errors.js";
import { apiFailure } from "../api/response.js";
import { createApproverApplicationSession } from "../approver-session/session.js";
import type { ServiceConfiguration } from "../config.js";
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

const MAX_JSON_BODY_BYTES = 4096;
const OAUTH_NETWORK_TIMEOUT_MS = 30_000;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function handleApproverIdentityAuthorize(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		requireSameOriginRequest(request, configuration.publicOrigin);
		const body = await readJsonBody(request);
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

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiError("INVALID_REQUEST", 415, "Expected an application/json request body");
	}
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
		throw new ApiError("INVALID_REQUEST", 413, "Request body is too large");
	}
	if (!request.body) throw new ApiError("INVALID_REQUEST", 400, "Request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
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
	if (!isRecord(parsed)) {
		throw new ApiError("INVALID_REQUEST", 400, "Request body must be an object");
	}
	return parsed;
}

function requireSameOriginRequest(request: Request, publicOrigin: string): void {
	if (
		request.headers.get("origin") !== publicOrigin ||
		request.headers.get("x-emdash-request") !== "1"
	) {
		throw new ApiError("CSRF_INVALID", 403, "Request origin could not be verified");
	}
}

function redirectToAuthorization(url: URL, stateCookie: string, requestId: string): Response {
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
		const body = await readJsonBody(request);
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
		logOAuthError("oauth_authorization_error", requestId, error);
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
		const body = await readJsonBody(request);
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
		logOAuthError("oauth_delegation_authorization_error", requestId, error);
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
		await client.callback(params);
		const headers = new Headers({
			"cache-control": "no-store",
			location: new URL(route.redirectTarget, configuration.publicOrigin).toString(),
			"x-content-type-options": "nosniff",
			"x-request-id": requestId,
		});
		headers.append("set-cookie", clearOAuthRouteCookie());
		if (route.purpose === "publisher_identity") {
			await client.revoke();
			const created = await createPublisherApplicationSession(env.PUBLISHER_DO, route.expectedDid);
			for (const cookie of created.setCookieHeaders) headers.append("set-cookie", cookie);
		} else if (route.purpose === "approver_identity") {
			const created = await createApproverApplicationSession(env.APPROVER_DO, route.expectedDid);
			for (const cookie of created.setCookieHeaders) headers.append("set-cookie", cookie);
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
