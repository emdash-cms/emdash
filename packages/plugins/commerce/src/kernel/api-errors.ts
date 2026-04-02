import {
	COMMERCE_ERRORS,
	type CommerceErrorCode,
	type CommerceWireErrorCode,
	commerceErrorCodeToWire,
} from "./errors.js";

export type CommerceApiError = {
	code: CommerceWireErrorCode;
	message: string;
	httpStatus: number;
	retryable: boolean;
	details?: Record<string, unknown>;
};

export type CommerceApiErrorInput = {
	code: CommerceErrorCode;
	message: string;
	details?: Record<string, unknown>;
};

export function toCommerceApiError(input: CommerceApiErrorInput): CommerceApiError {
	const { code, message, details } = input;
	const meta = COMMERCE_ERRORS[code];

	const payload: CommerceApiError = {
		code: commerceErrorCodeToWire(code),
		message,
		httpStatus: meta.httpStatus,
		retryable: meta.retryable,
	};

	if (details !== undefined) {
		payload.details = details;
	}

	return payload;
}

