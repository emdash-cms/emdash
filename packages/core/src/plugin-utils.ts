/**
 * Shared utilities for plugin admin UIs.
 *
 * Plugin admin components (`admin.tsx`) run inside the EmDash admin dashboard.
 * This module provides the common helpers they all need: API fetching with CSRF
 * protection, response envelope unwrapping, and type narrowing.
 *
 * Import as: `import { apiFetch, parseApiResponse, isRecord } from "emdash/plugin-utils";`
 */

import type { EmDashHandlers } from "./astro/types.js";

export type PublicPluginApiRouteHandler = EmDashHandlers["handlePublicPluginApiRoute"];

export interface PublicPluginRuntimeLocals {
	emdash?: {
		handlePublicPluginApiRoute?: PublicPluginApiRouteHandler;
	};
}

/**
 * Fetch wrapper that adds the `X-EmDash-Request` CSRF protection header.
 *
 * All plugin admin API calls should use this instead of raw `fetch()`.
 * State-changing endpoints reject requests without this header.
 */
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("X-EmDash-Request", "1");
	return fetch(input, { ...init, headers });
}

/**
 * Get the public-only plugin route dispatcher exposed to SSR page components.
 *
 * This intentionally reads `handlePublicPluginApiRoute`, not the raw
 * `handlePluginApiRoute` used by core's authenticated plugin API route.
 */
export function getPublicPluginApiRouteHandler(
	locals: PublicPluginRuntimeLocals | null | undefined,
): PublicPluginApiRouteHandler | undefined {
	const handler = locals?.emdash?.handlePublicPluginApiRoute;
	return typeof handler === "function" ? handler : undefined;
}

/**
 * Parse an API response, unwrapping the `{ data: T }` envelope.
 *
 * All plugin API routes return success responses wrapped in `{ data: ... }`
 * by `apiSuccess()`. This helper unwraps that envelope and handles errors.
 *
 * On error responses (non-2xx), throws an Error with the server's message
 * (from `{ error: { message } }`) or the fallback message.
 *
 * @example
 * ```ts
 * const res = await apiFetch("/_emdash/api/plugins/my-plugin/items");
 * const { items } = await parseApiResponse<{ items: Item[] }>(res, "Failed to load items");
 * ```
 */
export async function parseApiResponse<T>(
	response: Response,
	fallbackMessage = "Request failed",
): Promise<T> {
	if (!response.ok) {
		throw new Error(await getErrorMessage(response, `${fallbackMessage}: ${response.statusText}`));
	}
	const body: { data: T } = await response.json();
	return body.data;
}

/**
 * Extract the error message from a failed API response.
 *
 * Error responses use the shape `{ error: { code, message } }`. This helper
 * parses that body and returns the message, falling back to the provided default.
 * Swallows JSON parse failures gracefully.
 *
 * @example
 * ```ts
 * if (!res.ok) {
 *   setError(await getErrorMessage(res, "Failed to save"));
 *   return;
 * }
 * ```
 */
export async function getErrorMessage(response: Response, fallback: string): Promise<string> {
	const body: unknown = await response.json().catch(() => ({}));
	if (isRecord(body) && isRecord(body.error)) {
		const msg = body.error.message;
		if (typeof msg === "string") return msg;
	}
	return fallback;
}

/**
 * Narrow `unknown` to a plain object record.
 *
 * Useful for safely inspecting untyped API responses before accessing properties.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
