import { env } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME, type ServiceMode } from "./service-control-do.js";

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

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

export async function handleReadiness(_request: Request, requestId: string): Promise<Response> {
	try {
		await control().checkReadiness();
		return apiSuccess({ status: "ready" }, requestId);
	} catch {
		throw new ApiError("SERVICE_UNAVAILABLE", 503, "Service dependency is unavailable");
	}
}

export async function handleSetServiceMode(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
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
		return apiSuccess({ state: result.value, replayed: result.replayed }, requestId);
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
