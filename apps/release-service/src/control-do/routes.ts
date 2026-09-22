import { env } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import { startEncryptionVerificationWorkflow } from "../workflows/encryption-verification.js";
import { SERVICE_CONTROL_OBJECT_NAME, type ServiceMode } from "./service-control-do.js";

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const ENCRYPTION_RETIRE_PATH_PATTERN = /^\/admin\/api\/encryption\/keys\/([1-9][0-9]*)\/retire$/;

function requireActor(actor: AccessActor | null): AccessActor {
	if (!actor) throw new Error("Access actor missing from protected operator route");
	return actor;
}

function control() {
	return env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validReasonCode(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && REASON_CODE_PATTERN.test(value));
}

function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value) throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	return value;
}

async function requestDigest(parts: readonly unknown[]): Promise<string> {
	const encoded = new TextEncoder().encode(JSON.stringify(parts));
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

function parseInteger(
	value: string | null,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === null) return fallback;
	if (!DECIMAL_INTEGER_PATTERN.test(value)) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
	}
	return parsed;
}

function mapControlError(error: unknown): never {
	if (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "CONTROL_INPUT_INVALID"
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid service-control request");
	}
	throw error;
}

export async function handleServiceStatus(
	_request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const state = await control().readServiceState(requireActor(accessActor));
	return apiSuccess({ state }, requestId);
}

export async function handleReadiness(
	_request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		if (!(await control().checkReadiness(configuration.encryption.currentKeyVersion))) {
			throw new ApiError("SERVICE_UNAVAILABLE", 503, "Service dependency is unavailable");
		}
		return apiSuccess({ status: "ready" }, requestId);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError("SERVICE_UNAVAILABLE", 503, "Service dependency is unavailable");
	}
}

export async function handleSetServiceMode(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const actor = requireActor(accessActor);
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["mode", "reasonCode"]) ||
		(body["mode"] !== "active" &&
			body["mode"] !== "admission-paused" &&
			body["mode"] !== "publication-paused") ||
		!validReasonCode(body["reasonCode"]) ||
		(body["mode"] === "active") !== (body["reasonCode"] === null)
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid service mode request");
	}
	const mode: ServiceMode = body["mode"];
	const reasonCode = body["reasonCode"];
	try {
		if (mode === "active") {
			const keys = await control().readEncryptionKeys(actor);
			if (
				keys.find((key) => key.status === "active")?.version !==
				configuration.encryption.currentKeyVersion
			) {
				throw new ApiError(
					"ENCRYPTION_OPERATION_FAILED",
					409,
					"Configured encryption key has not been activated",
				);
			}
		}
		const result = await control().setServiceMode({
			actor,
			idempotencyKey: requireIdempotencyKey(request),
			requestDigest: await requestDigest(["service-mode", mode, reasonCode]),
			mode,
			reasonCode,
		});
		if (!result.ok) {
			throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
		}
		if (mode === "publication-paused") {
			writeOperationsMetric({
				event: "publication_paused",
				outcome: reasonCode ?? "unspecified",
				scope: "service",
				requestId,
			});
		}
		return apiSuccess({ state: result.value, replayed: result.replayed }, requestId);
	} catch (error) {
		mapControlError(error);
	}
}

export function matchRetireEncryptionKeyPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = ENCRYPTION_RETIRE_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) && version >= 1 && version <= 2_147_483_647
		? { version: match[1] }
		: null;
}

export async function handleEncryptionKeyStatus(
	_request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const actor = requireActor(accessActor);
	const keys = await control().readEncryptionKeys(actor);
	const activeVersion = keys.find((key) => key.status === "active")?.version;
	if (activeVersion === undefined) {
		throw new ApiError("SERVICE_UNAVAILABLE", 503, "Encryption key state is unavailable");
	}
	const verification = await control().readEncryptionVerification(actor, activeVersion);
	return apiSuccess(
		{
			configured: {
				activeVersion: configuration.encryption.currentKeyVersion,
				versions: configuration.encryption.availableKeyVersions,
			},
			keys,
			verification,
		},
		requestId,
	);
}

export async function handleActivateEncryptionKey(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const actor = requireActor(accessActor);
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["version"]) ||
		!Number.isSafeInteger(body["version"]) ||
		Number(body["version"]) < 1 ||
		Number(body["version"]) > 2_147_483_647
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid encryption key activation request");
	}
	const version = Number(body["version"]);
	if (
		configuration.encryption.currentKeyVersion !== version ||
		!configuration.encryption.availableKeyVersions.includes(version)
	) {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Encryption key is not the configured active version",
		);
	}
	if ((await control().readServiceState(actor)).mode !== "publication-paused") {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Publication must be paused before activating an encryption key",
		);
	}
	try {
		const result = await control().activateEncryptionKey({
			actor,
			idempotencyKey: requireIdempotencyKey(request),
			requestDigest: await requestDigest(["encryption-key-activate", version]),
			version,
		});
		if (!result.ok) {
			throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
		}
		return apiSuccess({ key: result.value, replayed: result.replayed }, requestId);
	} catch (error) {
		mapControlError(error);
	}
}

export async function handleStartEncryptionVerification(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const actor = requireActor(accessActor);
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["retiringVersion"]) ||
		!Number.isSafeInteger(body["retiringVersion"]) ||
		Number(body["retiringVersion"]) < 1 ||
		Number(body["retiringVersion"]) >= configuration.encryption.currentKeyVersion ||
		!configuration.encryption.availableKeyVersions.includes(Number(body["retiringVersion"]))
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid encryption verification request");
	}
	if ((await control().readServiceState(actor)).mode !== "publication-paused") {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Publication must be paused before verifying encryption",
		);
	}
	const retiringVersion = Number(body["retiringVersion"]);
	const keys = await control().readEncryptionKeys(actor);
	if (
		keys.find((key) => key.status === "active")?.version !==
			configuration.encryption.currentKeyVersion ||
		keys.find((key) => key.version === retiringVersion)?.status !== "readable"
	) {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Encryption key control state is not ready for verification",
		);
	}
	const campaignId = requireIdempotencyKey(request);
	const result = await startEncryptionVerificationWorkflow(env.ENCRYPTION_VERIFICATION_WORKFLOW, {
		campaignId,
		targetKeyVersion: configuration.encryption.currentKeyVersion,
		retiringKeyVersion: retiringVersion,
		actorIdentity: actor.identity,
	});
	if (!result.ok) {
		throw new ApiError("WORKFLOW_UNAVAILABLE", 503, "Encryption verification could not start");
	}
	return apiSuccess(result, requestId, result.created ? 202 : 200);
}

export async function handleRetireEncryptionKey(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const actor = requireActor(accessActor);
	const body = await readJsonObject(request);
	const version = Number(params["version"]);
	if (!hasExactKeys(body, []) || !Number.isSafeInteger(version) || version < 1) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid encryption key retirement request");
	}
	if (configuration.encryption.availableKeyVersions.includes(version)) {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Encryption key remains configured and cannot be retired",
		);
	}
	if ((await control().readServiceState(actor)).mode !== "publication-paused") {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Publication must be paused before retiring an encryption key",
		);
	}
	const keys = await control().readEncryptionKeys(actor);
	const activeVersion = keys.find((key) => key.status === "active")?.version;
	if (
		activeVersion === undefined ||
		!(await control().readEncryptionVerification(actor, activeVersion))
	) {
		throw new ApiError(
			"ENCRYPTION_OPERATION_FAILED",
			409,
			"Encryption key rotation has not been verified",
		);
	}
	try {
		const result = await control().retireEncryptionKey({
			actor,
			idempotencyKey: requireIdempotencyKey(request),
			requestDigest: await requestDigest(["encryption-key-retire", version]),
			version,
		});
		if (!result.ok) {
			throw new ApiError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key conflicts with prior use");
		}
		return apiSuccess({ key: result.value, replayed: result.replayed }, requestId);
	} catch (error) {
		mapControlError(error);
	}
}

export async function handleControlAudit(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	const url = new URL(request.url);
	if ([...url.searchParams.keys()].some((key) => key !== "after" && key !== "limit")) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid pagination parameters");
	}
	const after = parseInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = parseInteger(url.searchParams.get("limit"), 50, 1, 100);
	try {
		const rows = await control().listAudit(requireActor(accessActor), after, limit + 1);
		const items = rows.slice(0, limit);
		const nextCursor = rows.length > limit ? String(items.at(-1)?.sequence) : undefined;
		return apiSuccess({ items, ...(nextCursor ? { nextCursor } : {}) }, requestId);
	} catch (error) {
		mapControlError(error);
	}
}
