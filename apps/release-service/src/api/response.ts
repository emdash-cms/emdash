import { ApiError, serializeApiError } from "./errors.js";

export type ApiResponse<T> =
	| { data: T; requestId: string }
	| { error: ReturnType<typeof serializeApiError>; requestId: string };

const JSON_HEADERS = {
	"cache-control": "no-store",
	"content-type": "application/json; charset=utf-8",
	"x-content-type-options": "nosniff",
} as const;

export function apiSuccess<T>(data: T, requestId: string, status = 200): Response {
	return Response.json({ data, requestId } satisfies ApiResponse<T>, {
		status,
		headers: { ...JSON_HEADERS, "x-request-id": requestId },
	});
}

export function apiFailure(error: unknown, requestId: string, fallbackStatus = 500): Response {
	const status = error instanceof ApiError ? error.status : fallbackStatus;
	return Response.json(
		{ error: serializeApiError(error), requestId } satisfies ApiResponse<never>,
		{ status, headers: { ...JSON_HEADERS, "x-request-id": requestId } },
	);
}
