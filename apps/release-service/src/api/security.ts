import type { ServiceConfiguration } from "../config.js";
import { ApiError } from "./errors.js";

export const MAX_JSON_BODY_BYTES = 256 * 1024;

const encoder = new TextEncoder();

async function secretsEqual(left: string, right: string): Promise<boolean> {
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function requireAllowedOrigin(request: Request, config: ServiceConfiguration): string {
	const origin = request.headers.get("origin");
	if (!origin || !config.allowedOrigins.has(origin)) {
		throw new ApiError("ORIGIN_NOT_ALLOWED", 403, "Request origin is not allowed");
	}
	return origin;
}

export function getCorsHeaders(
	request: Request,
	config: ServiceConfiguration,
): Record<string, string> {
	const origin = requireAllowedOrigin(request, config);
	return {
		"access-control-allow-credentials": "true",
		"access-control-allow-origin": origin,
		vary: "Origin",
	};
}

export function getCorsPreflightHeaders(
	request: Request,
	config: ServiceConfiguration,
	allowedMethods: readonly string[],
): Record<string, string> {
	return {
		...getCorsHeaders(request, config),
		"access-control-allow-headers":
			"Authorization, Content-Type, Idempotency-Key, X-EmDash-CSRF, X-Request-ID",
		"access-control-allow-methods": allowedMethods.join(", "),
		"access-control-max-age": "600",
	};
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const declaredLength = Number(contentLength);
		if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
			throw new ApiError("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
		}
	}
	if (!request.body) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ApiError("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function parseJsonMutation(
	request: Request,
	config: ServiceConfiguration,
	expectedCsrfToken: string | null,
	maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
	if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(request.method)) {
		throw new ApiError("METHOD_NOT_ALLOWED", 405, "Mutation requires a state-changing HTTP method");
	}
	requireAllowedOrigin(request, config);
	const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new ApiError("UNSUPPORTED_MEDIA_TYPE", 415, "Content-Type must be application/json");
	}
	if (!expectedCsrfToken) {
		throw new ApiError("UNAUTHENTICATED", 401, "Authentication required");
	}
	const suppliedCsrfToken = request.headers.get("x-emdash-csrf");
	if (!suppliedCsrfToken || !(await secretsEqual(suppliedCsrfToken, expectedCsrfToken))) {
		throw new ApiError("CSRF_INVALID", 403, "CSRF validation failed");
	}
	const bytes = await readBoundedBody(request, maxBytes);
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new ApiError("INVALID_JSON", 400, "Request body must be valid JSON");
	}
}
