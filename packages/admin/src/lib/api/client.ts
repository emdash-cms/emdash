/**
 * Base API client configuration and shared types
 */

import type { Element } from "@emdash-cms/blocks";

export const API_BASE = "/_emdash/api";

/**
 * Fetch wrapper that adds the X-EmDash-Request CSRF protection header
 * to all requests. All API calls should use this instead of raw fetch().
 */
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("X-EmDash-Request", "1");
	return fetch(input, { ...init, headers });
}

/**
 * Throw an error with the message from the API response body if available,
 * falling back to a generic message. All API error responses use the shape
 * `{ error: { code, message } }`.
 */
export async function throwResponseError(res: Response, fallback: string): Promise<never> {
	const body: unknown = await res.json().catch(() => ({}));
	let message: string | undefined;
	if (typeof body === "object" && body !== null && "error" in body) {
		const { error } = body;
		if (typeof error === "object" && error !== null && "message" in error) {
			const { message: msg } = error;
			if (typeof msg === "string") message = msg;
		}
	}
	throw new Error(message || `${fallback}: ${res.statusText}`);
}

/**
 * Generic paginated result
 */
export interface FindManyResult<T> {
	items: T[];
	nextCursor?: string;
}

/**
 * Admin manifest describing available collections and plugins
 */
export interface AdminManifest {
	version: string;
	hash: string;
	collections: Record<
		string,
		{
			label: string;
			labelSingular: string;
			supports: string[];
			hasSeo: boolean;
			urlPattern?: string;
			fields: Record<
				string,
				{
					kind: string;
					label?: string;
					required?: boolean;
					widget?: string;
					options?: Array<{ value: string; label: string }>;
				}
			>;
		}
	>;
	plugins: Record<
		string,
		{
			name?: string;
			version?: string;
			/** Package name for dynamic import (e.g., "@emdash-cms/plugin-audit-log") */
			package?: string;
			/** Whether the plugin is enabled */
			enabled?: boolean;
			/**
			 * How this plugin renders its admin UI:
			 * - "react": Trusted plugin with React components
			 * - "blocks": Declarative Block Kit UI via admin route handler
			 * - "none": No admin UI
			 */
			adminMode?: "react" | "blocks" | "none";
			adminPages?: Array<{
				path: string;
				label?: string;
				icon?: string;
			}>;
			dashboardWidgets?: Array<{
				id: string;
				title?: string;
				size?: "full" | "half" | "third";
			}>;
			fieldWidgets?: Array<{
				name: string;
				label: string;
				fieldTypes: string[];
				elements?: import("@emdash-cms/blocks").Element[];
			}>;
			/** Block types for Portable Text editor */
			portableTextBlocks?: Array<{
				type: string;
				label: string;
				icon?: string;
				description?: string;
				placeholder?: string;
				fields?: Element[];
			}>;
		}
	>;
	/**
	 * Auth mode for the admin UI. When "passkey", the security settings
	 * (passkey management, self-signup domains) are shown. When using
	 * external auth (e.g., "cloudflare-access"), these are hidden since
	 * authentication is handled externally.
	 */
	authMode: string;
	/**
	 * Whether self-signup is enabled (at least one allowed domain is active).
	 * Used by the login page to conditionally show the "Sign up" link.
	 */
	signupEnabled?: boolean;
	/**
	 * i18n configuration. Present when multiple locales are configured.
	 */
	i18n?: {
		defaultLocale: string;
		locales: string[];
	};
	/**
	 * Taxonomy definitions for the admin sidebar.
	 */
	taxonomies?: Array<{
		name: string;
		label: string;
		labelSingular?: string;
		hierarchical: boolean;
		collections: string[];
	}>;
	/**
	 * Marketplace registry URL. Present when `marketplace` is configured
	 * in the EmDash integration. Enables marketplace features in the UI.
	 */
	marketplace?: string;
}

/**
 * Parse an API response with the { data: T } envelope.
 *
 * Handles error responses via throwResponseError, then unwraps the data envelope.
 * Replaces both bare `response.json()` and field-unwrap patterns.
 */
export async function parseApiResponse<T>(
	response: Response,
	fallbackMessage = "Request failed",
): Promise<T> {
	if (!response.ok) await throwResponseError(response, fallbackMessage);
	const body: { data: T } = await response.json();
	return body.data;
}

/**
 * Fetch admin manifest
 */
export async function fetchManifest(): Promise<AdminManifest> {
	const response = await apiFetch(`${API_BASE}/manifest`);
	return parseApiResponse<AdminManifest>(response, "Failed to fetch manifest");
}
