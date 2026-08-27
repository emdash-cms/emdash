export type ApiErrorCode =
	| "ACCESS_DENIED"
	| "APPROVAL_INVALID"
	| "APPROVER_SESSION_INVALID"
	| "APPROVER_SUSPENDED"
	| "CONFIGURATION_ERROR"
	| "CREDENTIAL_LIMIT_REACHED"
	| "CREDENTIAL_NOT_FOUND"
	| "CREDENTIAL_REVOKED"
	| "CSRF_INVALID"
	| "INTERNAL_ERROR"
	| "INVALID_REQUEST"
	| "INTENT_NOT_APPROVABLE"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "OAUTH_AUTHORIZATION_FAILED"
	| "OAUTH_CALLBACK_INVALID"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SUSPENDED"
	| "PROFILE_CHANGED"
	| "PROFILE_FETCH_FAILED";

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
