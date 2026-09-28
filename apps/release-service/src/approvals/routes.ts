import type { RegistrationResponse } from "@emdash-cms/auth/passkey";
import { env } from "cloudflare:workers";

import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import { ApproverStoreError } from "../approver-do/store.js";
import {
	ApproverSessionError,
	requireApproverApplicationSession,
} from "../approver-session/session.js";
import type { ServiceConfiguration } from "../config.js";
import {
	ApprovalPasskeyError,
	beginApproverCredentialRegistration,
	completeApproverCredentialRegistration,
} from "./passkeys.js";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGITS_PATTERN = /^[0-9]+$/;
const CREDENTIAL_PATH_PREFIX = "/v1/approver/credentials/";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
		for (;;) {
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
	if (!isRecord(parsed))
		throw new ApiError("INVALID_REQUEST", 400, "Request body must be an object");
	return parsed;
}

function passkeyRelyingParty(publicOrigin: string) {
	const url = new URL(publicOrigin);
	return { rpId: url.hostname, origin: url.origin };
}

function requireBase64Url(value: unknown, maximum: number): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > maximum ||
		!BASE64URL_PATTERN.test(value)
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey response");
	}
	return value;
}

function parseRegistrationResponse(body: Record<string, unknown>): RegistrationResponse {
	if (
		!isRecord(body["response"]) ||
		body["type"] !== "public-key" ||
		(body["authenticatorAttachment"] !== undefined &&
			body["authenticatorAttachment"] !== "platform" &&
			body["authenticatorAttachment"] !== "cross-platform")
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey response");
	}
	const response = body["response"];
	const transports = response["transports"];
	if (
		transports !== undefined &&
		(!Array.isArray(transports) ||
			transports.some(
				(value) =>
					value !== "usb" &&
					value !== "nfc" &&
					value !== "ble" &&
					value !== "internal" &&
					value !== "hybrid",
			))
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey response");
	}
	const id = requireBase64Url(body["id"], 1024);
	const rawId = requireBase64Url(body["rawId"], 1024);
	if (rawId !== id) throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey response");
	return {
		id,
		rawId,
		type: "public-key",
		response: {
			clientDataJSON: requireBase64Url(response["clientDataJSON"], MAX_JSON_BODY_BYTES),
			attestationObject: requireBase64Url(response["attestationObject"], MAX_JSON_BODY_BYTES),
			...(transports ? { transports } : {}),
		},
		...(body["authenticatorAttachment"]
			? { authenticatorAttachment: body["authenticatorAttachment"] }
			: {}),
	};
}

function mapApproverError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (error instanceof ApproverSessionError) {
		return new ApiError(
			error.code === "APPROVER_SUSPENDED" ? "APPROVER_SUSPENDED" : "APPROVER_SESSION_INVALID",
			error.code === "APPROVER_SUSPENDED" ? 403 : 401,
			"Approver session is not valid",
		);
	}
	if (error instanceof ApprovalPasskeyError || error instanceof ApproverStoreError) {
		return new ApiError("APPROVAL_INVALID", 400, "Passkey operation could not be completed");
	}
	throw error;
}

function listLimit(url: URL): number {
	const value = url.searchParams.get("limit");
	if (value === null) return 50;
	if (!DIGITS_PATTERN.test(value)) throw new ApiError("INVALID_REQUEST", 400, "Invalid limit");
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid limit");
	}
	return Math.min(limit, 100);
}

export function matchApproverCredentialPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	if (!pathname.startsWith(CREDENTIAL_PATH_PREFIX)) return null;
	const encoded = pathname.slice(CREDENTIAL_PATH_PREFIX.length);
	if (encoded.length === 0 || encoded === "options" || encoded.includes("/")) return null;
	let credentialId: string;
	try {
		credentialId = decodeURIComponent(encoded);
	} catch {
		return null;
	}
	return BASE64URL_PATTERN.test(credentialId) && credentialId.length <= 1024
		? { credentialId }
		: null;
}

export async function handleListApproverCredentials(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			_configuration.publicOrigin,
		);
		const url = new URL(request.url);
		const after = url.searchParams.get("after");
		const limit = listLimit(url);
		const items = await env.APPROVER_DO.getByName(session.approverDid).listCredentials(
			session.approverDid,
			after,
			limit,
		);
		return apiSuccess(
			{
				items,
				...(items.length === limit ? { nextCursor: items.at(-1)?.id } : {}),
			},
			requestId,
		);
	} catch (error) {
		return apiFailure(mapApproverError(error), requestId);
	}
}

export async function handleBeginApproverCredentialRegistration(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const body = await readJsonBody(request);
		if (Object.keys(body).length !== 1 || typeof body["name"] !== "string") {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid passkey registration request");
		}
		const options = await beginApproverCredentialRegistration(
			env.APPROVER_DO.getByName(session.approverDid),
			session.approverDid,
			body["name"],
			passkeyRelyingParty(configuration.publicOrigin),
		);
		return apiSuccess(options, requestId);
	} catch (error) {
		return apiFailure(mapApproverError(error), requestId);
	}
}

export async function handleCompleteApproverCredentialRegistration(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const response = parseRegistrationResponse(await readJsonBody(request));
		const result = await completeApproverCredentialRegistration(
			env.APPROVER_DO.getByName(session.approverDid),
			session.approverDid,
			response,
			passkeyRelyingParty(configuration.publicOrigin),
		);
		if (!result.ok) {
			return apiFailure(
				result.code === "CREDENTIAL_LIMIT_REACHED"
					? new ApiError("CREDENTIAL_LIMIT_REACHED", 409, "Credential limit reached")
					: new ApiError("APPROVAL_INVALID", 409, "Credential is already enrolled"),
				requestId,
			);
		}
		return apiSuccess(result.credential, requestId, 201);
	} catch (error) {
		return apiFailure(mapApproverError(error), requestId);
	}
}

export async function handleRevokeApproverCredential(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	try {
		const session = await requireApproverApplicationSession(
			request,
			env.APPROVER_DO,
			configuration.publicOrigin,
			{ requireCsrf: true },
		);
		const credentialId = params["credentialId"];
		if (!credentialId) throw new ApiError("NOT_FOUND", 404, "Not found");
		const result = await env.APPROVER_DO.getByName(session.approverDid).revokeCredential(
			session.approverDid,
			credentialId,
		);
		if (!result.ok) {
			return apiFailure(
				result.code === "CREDENTIAL_REVOKED"
					? new ApiError("CREDENTIAL_REVOKED", 409, "Credential is already revoked")
					: new ApiError("CREDENTIAL_NOT_FOUND", 404, "Credential not found"),
				requestId,
			);
		}
		return apiSuccess(result.credential, requestId);
	} catch (error) {
		return apiFailure(mapApproverError(error), requestId);
	}
}
