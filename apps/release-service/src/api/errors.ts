export type ApiErrorCode =
	| "CONFIGURATION_ERROR"
	| "INTERNAL_ERROR"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED";

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
