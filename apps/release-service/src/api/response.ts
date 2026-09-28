import { ApiError, serializeApiError } from "./errors.js";

const JSON_HEADERS = {
	"cache-control": "no-store",
	"content-type": "application/json; charset=utf-8",
	"x-content-type-options": "nosniff",
} as const;

export function apiSuccess<T>(data: T, requestId: string, status = 200): Response {
	return Response.json(
		{ data, requestId },
		{ status, headers: { ...JSON_HEADERS, "x-request-id": requestId } },
	);
}

export function apiFailure(error: unknown, requestId: string): Response {
	const status = error instanceof ApiError ? error.status : 500;
	return Response.json(
		{ error: serializeApiError(error), requestId },
		{ status, headers: { ...JSON_HEADERS, "x-request-id": requestId } },
	);
}
