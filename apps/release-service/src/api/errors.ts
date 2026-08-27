export type ApiErrorCode =
	| "CONFIGURATION_ERROR"
	| "CSRF_INVALID"
	| "INTERNAL_ERROR"
	| "INVALID_REQUEST"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "OAUTH_AUTHORIZATION_FAILED"
	| "OAUTH_CALLBACK_INVALID"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SUSPENDED";

export interface SerializedApiError {
	code: ApiErrorCode;
	message: string;
}

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly status: number;

	constructor(code: ApiErrorCode, status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
	}
}

export function serializeApiError(error: unknown): SerializedApiError {
	return error instanceof ApiError
		? { code: error.code, message: error.message }
		: { code: "INTERNAL_ERROR", message: "Internal server error" };
}
