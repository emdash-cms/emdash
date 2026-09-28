import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";
import { base64url, type JWTVerifyGetKey } from "jose";

import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../control-do/service-control-do.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import { verifyGitHubActionsToken } from "../workload/github-oidc.js";
import { evaluateWorkloadPolicy, digestWorkloadIdempotencyIdentity } from "../workload/policy.js";
import { WorkloadIdentityError } from "../workload/types.js";
import {
	persistWorkloadStagedArtifact,
	WorkloadStagingError,
	workloadArtifactSourceUrl,
	type WorkloadArtifactSlot,
} from "./workload-staging.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const SCREENSHOT_SLOT_PATTERN = /^screenshots\[([0-7])\]$/;
const MAX_AUTHORIZATION_CHARS = 16 * 1024;
const RATE_LIMIT_IDEMPOTENCY_MS = 24 * 60 * 60_000;

export interface WorkloadStagingRouteDependencies {
	keyResolver?: JWTVerifyGetKey;
	now?: () => number;
}

function requireHeader(request: Request, name: string): string {
	const value = request.headers.get(name);
	if (!value) throw new ApiError("INVALID_REQUEST", 400, "Valid artifact metadata required");
	return value;
}

function requireBearerToken(request: Request): string {
	const value = request.headers.get("authorization");
	if (
		!value ||
		value.length > MAX_AUTHORIZATION_CHARS ||
		!value.startsWith("Bearer ") ||
		value.slice(7).length === 0 ||
		value.slice(7).includes(" ") ||
		request.headers.has("cookie")
	) {
		throw new ApiError("AUTH_INVALID", 401, "Workload authentication failed");
	}
	return value.slice(7);
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
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

function requireSlot(value: string): WorkloadArtifactSlot {
	if (value === "package" || value === "icon" || value === "banner" || value === "provenance") {
		return value;
	}
	const screenshot = SCREENSHOT_SLOT_PATTERN.exec(value);
	if (screenshot?.[1]) return `screenshots[${Number(screenshot[1])}]`;
	throw new ApiError("INVALID_REQUEST", 400, "Valid artifact slot required");
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	if (error instanceof WorkloadIdentityError) {
		return apiFailure(
			new ApiError("AUTH_INVALID", 401, "Workload authentication failed"),
			requestId,
		);
	}
	if (error instanceof WorkloadStagingError) {
		const tooLarge = error.code === "WORKLOAD_STAGING_SIZE_MISMATCH";
		return apiFailure(
			new ApiError(
				"INVALID_REQUEST",
				tooLarge ? 413 : 400,
				tooLarge ? "Artifact body size is invalid" : "Artifact upload is invalid",
			),
			requestId,
		);
	}
	throw error;
}

export async function handleUploadWorkloadArtifact(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	dependencies: WorkloadStagingRouteDependencies = {},
): Promise<Response> {
	try {
		const idempotencyKey = requireIdempotencyKey(request);
		const identity = await verifyGitHubActionsToken(
			requireBearerToken(request),
			configuration.publicOrigin,
			dependencies.keyResolver,
		);
		const publisherDid = requireHeader(request, "x-emdash-publisher-did");
		const packageSlug = requireHeader(request, "x-emdash-package");
		const version = requireHeader(request, "x-emdash-version");
		const slot = requireSlot(requireHeader(request, "x-emdash-artifact-slot"));
		const checksum = requireHeader(request, "x-emdash-checksum");
		const contentType = requireHeader(request, "content-type").split(";", 1)[0]?.trim() ?? "";
		const rawContentLength = requireHeader(request, "content-length");
		if (
			!isDid(publisherDid) ||
			!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
			!VERSION_PATTERN.test(version) ||
			!CHECKSUM_PATTERN.test(checksum) ||
			!POSITIVE_INTEGER_PATTERN.test(rawContentLength) ||
			request.body === null
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Valid artifact metadata required");
		}
		const contentLength = Number(rawContentLength);
		if (!Number.isSafeInteger(contentLength)) {
			throw new ApiError("INVALID_REQUEST", 400, "Valid artifact metadata required");
		}
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		const policy = await publisher.getWorkloadPolicyIfInitialized(publisherDid, packageSlug);
		if (!policy || !evaluateWorkloadPolicy(identity, policy).ok) {
			throw new ApiError("WORKLOAD_NOT_ALLOWED", 403, "Workload is not authorized");
		}
		const admission = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).getAdmissionDecision(publisherDid);
		if (!admission.allowed) {
			throw new ApiError(
				admission.code === "PUBLISHER_SUSPENDED" ? "PUBLISHER_SUSPENDED" : "SERVICE_PAUSED",
				503,
				admission.code === "PUBLISHER_SUSPENDED"
					? "Publisher is suspended"
					: "Release admission is paused",
			);
		}
		const now = dependencies.now?.() ?? Date.now();
		const workloadRateKey = await digest([
			"staged-artifact-rate-limit",
			1,
			identity.repository.id,
			identity.workflow.ref,
			packageSlug,
		]);
		const rateLimitIdempotencyKey = `r:${await digest([
			"staged-artifact-rate-idempotency",
			1,
			idempotencyKey,
			identity.run.id,
			version,
			slot,
			checksum,
			contentType,
			contentLength,
		])}`;
		const rateLimit = await publisher.consumeIntentRateLimit({
			publisherDid,
			repositoryId: identity.repository.id,
			workloadKey: workloadRateKey,
			idempotencyKey: rateLimitIdempotencyKey,
			expiresAt: now + RATE_LIMIT_IDEMPOTENCY_MS,
			now,
		});
		if (!rateLimit.ok) {
			writeOperationsMetric({
				event: "staged_artifact_rate_limited",
				ownerHash: workloadRateKey,
				outcome: "denied",
				scope: rateLimit.scope,
				requestId,
			});
			const response = apiFailure(
				new ApiError("WORKLOAD_RATE_LIMITED", 429, "Release artifact upload rate limit exceeded"),
				requestId,
			);
			const headers = new Headers(response.headers);
			headers.set("retry-after", String(Math.max(1, Math.ceil((rateLimit.retryAt - now) / 1000))));
			return new Response(response.body, { status: response.status, headers });
		}
		const workloadDigest = await digestWorkloadIdempotencyIdentity(
			identity,
			publisherDid,
			packageSlug,
			version,
		);
		const staged = await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, {
			publisherDid,
			workloadDigest,
			packageSlug,
			version,
			slot,
			checksum,
			contentType,
			contentLength,
			body: request.body,
		});
		return apiSuccess(
			{
				artifact: {
					slot,
					checksum,
					contentType,
					size: contentLength,
					sourceUrl: workloadArtifactSourceUrl(configuration.publicOrigin, slot, checksum),
				},
				replayed: staged.replayed,
			},
			requestId,
			staged.replayed ? 200 : 201,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
