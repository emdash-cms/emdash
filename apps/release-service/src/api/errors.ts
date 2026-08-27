export type ApiErrorCode =
	| "ACCESS_DENIED"
	| "ACCESS_AUTH_INVALID"
	| "ACCESS_AUTH_REQUIRED"
	| "APPROVAL_INVALID"
	| "APPROVER_SESSION_INVALID"
	| "APPROVER_SUSPENDED"
	| "AUTH_INVALID"
	| "CONFIGURATION_ERROR"
	| "CREDENTIAL_LIMIT_REACHED"
	| "CREDENTIAL_NOT_FOUND"
	| "CREDENTIAL_REVOKED"
	| "CSRF_INVALID"
	| "DELEGATION_REQUIRED"
	| "IDEMPOTENCY_KEY_INVALID"
	| "IDEMPOTENCY_CONFLICT"
	| "INTERNAL_ERROR"
	| "INVALID_REQUEST"
	| "INTENT_NOT_APPROVABLE"
	| "INTENT_NOT_CANCELLABLE"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "OAUTH_AUTHORIZATION_FAILED"
	| "OAUTH_CALLBACK_INVALID"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SUSPENDED"
	| "PROFILE_CHANGED"
	| "PROFILE_FETCH_FAILED"
	| "RELEASE_EXISTS"
	| "SERVICE_PAUSED"
	| "SERVICE_UNAVAILABLE"
	| "VERSION_RESERVED"
	| "WORKFLOW_UNAVAILABLE"
	| "WORKLOAD_NOT_ALLOWED";

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
