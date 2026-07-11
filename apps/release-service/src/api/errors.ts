export const API_ERROR_CODES = [
	"CONFIGURATION_ERROR",
	"INTERNAL_ERROR",
	"NOT_FOUND",
	"METHOD_NOT_ALLOWED",
	"UNAUTHENTICATED",
	"FORBIDDEN",
	"ORIGIN_NOT_ALLOWED",
	"CSRF_INVALID",
	"UNSUPPORTED_MEDIA_TYPE",
	"PAYLOAD_TOO_LARGE",
	"INVALID_JSON",
	"INVALID_CURSOR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface SerializedApiError {
	code: ApiErrorCode;
	message: string;
	details?: unknown;
}

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly status: number;
	readonly details?: unknown;

	constructor(code: ApiErrorCode, status: number, message: string, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export function serializeApiError(error: unknown): SerializedApiError {
	if (error instanceof ApiError) {
		return error.details === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, details: error.details };
	}
	return { code: "INTERNAL_ERROR", message: "Internal server error" };
}
