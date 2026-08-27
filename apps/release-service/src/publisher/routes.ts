import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";

import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { serializeIntentResource } from "../intents/routes.js";
import { createPublisherOAuthClient } from "../oauth/custody.js";
import type { StoredWorkloadPolicy } from "../publisher-do/publisher-do.js";
import { WorkloadPolicyError } from "../publisher-do/workload-policy.js";
import {
	PublisherSessionError,
	requirePublisherApplicationSession,
} from "../publisher-session/session.js";

const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const WORKLOAD_PATH_PATTERN = /^\/v1\/publisher\/workloads\/([A-Za-z][A-Za-z0-9_-]{0,63})$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface PublisherRouteDependencies {
	revokeDelegation?: (publisherDid: `did:${string}:${string}`) => Promise<void>;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
	return value === null || (Number.isSafeInteger(value) && Number(value) >= 1);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
	return value;
}

function parseLimit(url: URL): number {
	const value = url.searchParams.get("limit");
	if (value === null) return DEFAULT_LIMIT;
	if (!POSITIVE_INTEGER_PATTERN.test(value)) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
	}
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
	}
	return limit;
}

function mapPublisherSessionError(error: PublisherSessionError): ApiError {
	if (error.code === "PUBLISHER_SUSPENDED") {
		return new ApiError("PUBLISHER_SUSPENDED", 403, "Publisher is suspended");
	}
	if (error.code === "CSRF_INVALID" || error.code === "ORIGIN_INVALID") {
		return new ApiError("CSRF_INVALID", 403, "Request origin could not be verified");
	}
	return new ApiError("PUBLISHER_SESSION_INVALID", 401, "Publisher session is not valid");
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	if (error instanceof PublisherSessionError) {
		return apiFailure(mapPublisherSessionError(error), requestId);
	}
	if (error instanceof WorkloadPolicyError) {
		return apiFailure(
			new ApiError("INVALID_REQUEST", 400, "Invalid workload policy request"),
			requestId,
		);
	}
	throw error;
}

async function publisherSession(
	request: Request,
	configuration: ServiceConfiguration,
	requireCsrf = false,
) {
	return await requirePublisherApplicationSession(
		request,
		env.PUBLISHER_DO,
		configuration.publicOrigin,
		{ requireCsrf },
	);
}

function samePolicy(
	policy: StoredWorkloadPolicy,
	input: {
		packageSlug: string;
		repository: string;
		repositoryId: string;
		repositoryOwnerId: string;
		workflowRef: string;
		allowedRefs: readonly string[];
		allowedEnvironments: readonly string[];
		active: boolean;
	},
): boolean {
	return (
		policy.packageSlug === input.packageSlug &&
		policy.repository === input.repository.toLowerCase() &&
		policy.repositoryId === input.repositoryId &&
		policy.repositoryOwnerId === input.repositoryOwnerId &&
		policy.workflowRef === input.workflowRef &&
		JSON.stringify(policy.allowedRefs) === JSON.stringify([...input.allowedRefs].toSorted()) &&
		JSON.stringify(policy.allowedEnvironments) ===
			JSON.stringify([...input.allowedEnvironments].toSorted()) &&
		policy.active === input.active
	);
}

export function sanitizedDelegation(
	value: Awaited<ReturnType<ReturnType<typeof env.PUBLISHER_DO.getByName>["getDelegation"]>>,
) {
	return value
		? {
				releaseNsid: value.releaseNsid,
				scope: value.scope,
				issuer: value.issuer,
				pdsUrl: value.pdsUrl,
				expiresAt: value.expiresAt,
				refreshBefore: value.refreshBefore,
				status: value.status,
				stateVersion: value.stateVersion,
			}
		: null;
}

export function matchPublisherWorkloadPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = WORKLOAD_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { packageSlug: match[1] } : null;
}

export async function handleGetPublisher(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await publisherSession(request, configuration);
		const delegation = await env.PUBLISHER_DO.getByName(session.publisherDid).getDelegation(
			session.publisherDid,
		);
		return apiSuccess(
			{
				publisher: {
					did: session.publisherDid,
					delegation: sanitizedDelegation(delegation),
					sessionExpiresAt: session.expiresAt,
				},
			},
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleRevokePublisherDelegation(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: PublisherRouteDependencies = {},
): Promise<Response> {
	try {
		requireIdempotencyKey(request);
		const session = await publisherSession(request, configuration, true);
		const body = await readJsonObject(request);
		if (!hasExactKeys(body, [])) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid delegation revocation request");
		}
		const publisherDid = session.publisherDid;
		if (!isDid(publisherDid)) {
			throw new ApiError("PUBLISHER_SESSION_INVALID", 401, "Publisher session is not valid");
		}
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const existing = await publisher.getDelegation(publisherDid);
		if (existing?.status === "active" || existing?.status === "reauthorization_required") {
			if (dependencies.revokeDelegation) {
				await dependencies.revokeDelegation(publisherDid);
			} else {
				const client = createPublisherOAuthClient({
					namespace: env.PUBLISHER_DO,
					encryption: configuration.encryption,
					oauth: configuration.oauth,
					flow: {
						purpose: "release_delegation",
						expectedDid: publisherDid,
						redirectTarget: "/",
					},
				});
				try {
					await client.revoke();
				} catch {
					const current = await publisher.getDelegation(publisherDid);
					if (current?.status !== "revoked") throw new Error("Delegation revocation failed");
				}
			}
		}
		const delegation = await publisher.getDelegation(publisherDid);
		return apiSuccess(
			{ publisher: { did: publisherDid, delegation: sanitizedDelegation(delegation) } },
			requestId,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleListPublisherWorkloads(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await publisherSession(request, configuration);
		const url = new URL(request.url);
		const limit = parseLimit(url);
		const cursor = url.searchParams.get("cursor");
		if (cursor !== null && !PACKAGE_SLUG_PATTERN.test(cursor)) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
		}
		const rows = await env.PUBLISHER_DO.getByName(session.publisherDid).listWorkloadPolicies(
			session.publisherDid,
			cursor,
			limit + 1,
		);
		const items = rows.slice(0, limit);
		const nextCursor = rows.length > limit ? items.at(-1)?.packageSlug : undefined;
		return apiSuccess({ items, ...(nextCursor ? { nextCursor } : {}) }, requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handlePutPublisherWorkload(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		requireIdempotencyKey(request);
		const session = await publisherSession(request, configuration, true);
		const body = await readJsonObject(request, 16 * 1024);
		if (
			!hasExactKeys(body, [
				"packageSlug",
				"repository",
				"repositoryId",
				"repositoryOwnerId",
				"workflowRef",
				"allowedRefs",
				"allowedEnvironments",
				"expectedVersion",
			]) ||
			typeof body["packageSlug"] !== "string" ||
			typeof body["repository"] !== "string" ||
			typeof body["repositoryId"] !== "string" ||
			typeof body["repositoryOwnerId"] !== "string" ||
			typeof body["workflowRef"] !== "string" ||
			!isStringArray(body["allowedRefs"]) ||
			!isStringArray(body["allowedEnvironments"]) ||
			!isPositiveIntegerOrNull(body["expectedVersion"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid workload policy request");
		}
		const publisher = env.PUBLISHER_DO.getByName(session.publisherDid);
		const input = {
			publisherDid: session.publisherDid,
			packageSlug: body["packageSlug"],
			repository: body["repository"],
			repositoryId: body["repositoryId"],
			repositoryOwnerId: body["repositoryOwnerId"],
			workflowRef: body["workflowRef"],
			allowedRefs: body["allowedRefs"],
			allowedEnvironments: body["allowedEnvironments"],
			active: true,
			expectedVersion: body["expectedVersion"],
		};
		const current = await publisher.getWorkloadPolicy(session.publisherDid, input.packageSlug);
		if (current && samePolicy(current, input)) {
			return apiSuccess({ policy: current, replayed: true }, requestId);
		}
		const result = await publisher.putWorkloadPolicy(input);
		if (!result.ok) {
			throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Workload policy changed");
		}
		return apiSuccess({ policy: result.policy, replayed: false }, requestId, current ? 200 : 201);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleDisablePublisherWorkload(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	try {
		requireIdempotencyKey(request);
		const session = await publisherSession(request, configuration, true);
		const packageSlug = params["packageSlug"];
		if (!packageSlug || !PACKAGE_SLUG_PATTERN.test(packageSlug)) {
			throw new ApiError("NOT_FOUND", 404, "Workload policy not found");
		}
		const body = await readJsonObject(request);
		if (!hasExactKeys(body, ["expectedVersion"]) || !isPositiveInteger(body["expectedVersion"])) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid workload policy request");
		}
		const publisher = env.PUBLISHER_DO.getByName(session.publisherDid);
		const current = await publisher.getWorkloadPolicy(session.publisherDid, packageSlug);
		if (!current) throw new ApiError("NOT_FOUND", 404, "Workload policy not found");
		if (!current.active) {
			return apiSuccess({ policy: current, replayed: true }, requestId);
		}
		const result = await publisher.putWorkloadPolicy({
			publisherDid: session.publisherDid,
			packageSlug: current.packageSlug,
			repository: current.repository,
			repositoryId: current.repositoryId,
			repositoryOwnerId: current.repositoryOwnerId,
			workflowRef: current.workflowRef,
			allowedRefs: current.allowedRefs,
			allowedEnvironments: current.allowedEnvironments,
			active: false,
			expectedVersion: body["expectedVersion"],
		});
		if (!result.ok) {
			throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Workload policy changed");
		}
		return apiSuccess({ policy: result.policy, replayed: false }, requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleListPublisherIntents(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await publisherSession(request, configuration);
		const url = new URL(request.url);
		const limit = parseLimit(url);
		const cursor = url.searchParams.get("cursor");
		if (cursor !== null && !ULID_PATTERN.test(cursor)) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
		}
		const rows = await env.PUBLISHER_DO.getByName(session.publisherDid).listIntents(
			session.publisherDid,
			cursor,
			limit + 1,
		);
		const items = await Promise.all(
			rows
				.slice(0, limit)
				.map((intent) =>
					serializeIntentResource(session.publisherDid, intent, configuration.publicOrigin),
				),
		);
		const nextCursor = rows.length > limit ? rows[limit - 1]?.id : undefined;
		return apiSuccess({ items, ...(nextCursor ? { nextCursor } : {}) }, requestId);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
