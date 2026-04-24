/**
 * API types for EmDash REST endpoints
 */

import type { ContentItem } from "../database/repositories/types.js";

/**
 * List response with cursor pagination
 */
export interface ListResponse<T> {
	items: T[];
	nextCursor?: string;
	/**
	 * Total number of rows matching the filters, ignoring pagination. Used
	 * by the admin to render a stable pagination denominator. Optional so
	 * callers that don't surface a row count don't pay for the extra query.
	 */
	total?: number;
}

/**
 * Content API responses
 */
export interface ContentListResponse extends ListResponse<ContentItem> {}

export interface ContentResponse {
	item: ContentItem;
	/** Opaque revision token for optimistic concurrency */
	_rev?: string;
}

/**
 * Manifest API response
 */
export interface ManifestResponse {
	version: string;
	hash: string;
	collections: Record<
		string,
		{
			label: string;
			labelSingular: string;
			supports: string[];
			fields: Record<string, FieldDescriptor>;
		}
	>;
	plugins: Record<
		string,
		{
			adminPages?: Array<{ path: string; component: string }>;
			widgets?: string[];
		}
	>;
}

export interface FieldDescriptor {
	kind: string;
	label?: string;
	required?: boolean;
	options?: Array<{ value: string; label: string }>;
}

/**
 * Discriminated union for handler results.
 *
 * Handlers return `ApiResult<T>` -- either `{ success: true, data: T }` or
 * `{ success: false, error: { code, message } }`. The `success` literal
 * enables TypeScript narrowing on `.data`.
 *
 * The generic `E` parameter defaults to `ErrorCode` but can be narrowed to
 * `OAuthErrorCode` for OAuth token-endpoint handlers.
 *
 * Use `unwrapResult()` from `error.ts` to convert to an HTTP Response.
 */
export type ApiResult<T, E extends string = string> =
	| { success: true; data: T }
	| {
			success: false;
			error: { code: E; message: string; details?: Record<string, unknown> };
	  };

/**
 * API request context
 */
export interface ApiContext {
	userId?: string;
	userRole?: string;
}
