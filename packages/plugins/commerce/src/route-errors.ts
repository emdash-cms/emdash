/**
 * Bridge kernel {@link toCommerceApiError} to {@link PluginRouteError} for route handlers.
 */

import { PluginRouteError } from "emdash";

import { toCommerceApiError, type CommerceApiErrorInput } from "./kernel/api-errors.js";

export function throwCommerceApiError(input: CommerceApiErrorInput): never {
	const e = toCommerceApiError(input);
	throw new PluginRouteError(e.code, e.message, e.httpStatus, {
		retryable: e.retryable,
		details: e.details,
	});
}
