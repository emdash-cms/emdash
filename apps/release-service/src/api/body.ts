import { ApiError } from "./errors.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 4096;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJsonObject(
	request: Request,
	maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiError("INVALID_REQUEST", 415, "Expected an application/json request body");
	}
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
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
			if (length > maxBytes) {
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
