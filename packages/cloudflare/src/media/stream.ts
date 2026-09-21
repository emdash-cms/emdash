/**
 * Cloudflare Stream Media Provider
 *
 * Provides integration with Cloudflare Stream for video hosting and streaming.
 *
 * Features:
 * - Browse uploaded videos
 * - Upload new videos (direct upload)
 * - Delete videos
 * - HLS/DASH streaming URLs
 * - Thumbnail generation
 *
 * @see https://developers.cloudflare.com/stream/
 */

import type { MediaProviderDescriptor } from "emdash/media";

/**
 * Cloudflare Stream configuration
 *
 * `*EnvVar` options are resolved in order: the matching direct config value,
 * then a Cloudflare Workers binding of that name, then `process.env` (Node
 * adapter, where there is no Workers binding).
 */
export interface CloudflareStreamConfig {
	/**
	 * Cloudflare Account ID
	 * If not provided, reads from accountIdEnvVar at runtime
	 */
	accountId?: string;

	/**
	 * Environment variable name containing the Account ID
	 * @default "CF_ACCOUNT_ID"
	 */
	accountIdEnvVar?: string;

	/**
	 * API Token with Stream permissions
	 * If not provided, reads from apiTokenEnvVar at runtime
	 * Should have "Stream: Read" and "Stream: Edit" permissions
	 */
	apiToken?: string;

	/**
	 * Environment variable name containing the API token
	 * @default "CF_STREAM_TOKEN"
	 */
	apiTokenEnvVar?: string;

	/**
	 * Customer subdomain for Stream delivery (optional)
	 * If not provided, uses customer-{hash}.cloudflarestream.com format
	 */
	customerSubdomain?: string;

	/**
	 * Default player controls setting
	 * @default true
	 */
	controls?: boolean;

	/**
	 * Autoplay videos (muted by default to comply with browser policies)
	 * @default false
	 */
	autoplay?: boolean;

	/**
	 * Loop videos
	 * @default false
	 */
	loop?: boolean;

	/**
	 * Mute videos
	 * @default false (true if autoplay is enabled)
	 */
	muted?: boolean;
}

// Cloudflare Stream icon (inline SVG as data URL)
const STREAM_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><g clip-path="url(#a)"><path fill="#F63" d="M59.87 30.176a11.73 11.73 0 0 0-8-2.72 19.3 19.3 0 0 0-37-4.59 13.63 13.63 0 0 0-9.67 3.19 14.599 14.599 0 0 0-5.2 11 14.24 14.24 0 0 0 14.18 14.25h37.88a12 12 0 0 0 7.81-21.13Zm-7.81 17.13H14.19A10.24 10.24 0 0 1 4 37.086a10.58 10.58 0 0 1 3.77-8 9.55 9.55 0 0 1 6.23-2.25c.637 0 1.273.058 1.9.17l1.74.31.51-1.69A15.29 15.29 0 0 1 48 29.686l.1 2.32 2.26-.36a8.239 8.239 0 0 1 6.91 1.62 8.098 8.098 0 0 1 2.73 6.1 8 8 0 0 1-7.94 7.94Z"/><path fill="#F63" fill-rule="evenodd" d="m25.72 24.89 3.02-1.72 15.085 8.936.004 3.44-15.087 8.973L25.72 42.8V24.89Zm4 3.51v10.883l9.168-5.452L29.72 28.4Z" clip-rule="evenodd"/></g><defs><clipPath id="a"><path fill="#fff" d="M0 0h64v64H0z"/></clipPath></defs></svg>')}`;

/**
 * Cloudflare Stream media provider
 *
 * @example
 * ```ts
 * import { cloudflareStream } from "@emdash-cms/cloudflare";
 *
 * emdash({
 *   mediaProviders: [
 *     // Uses CF_ACCOUNT_ID and CF_STREAM_TOKEN env vars by default
 *     cloudflareStream({}),
 *
 *     // Or with custom env var names
 *     cloudflareStream({
 *       accountIdEnvVar: "MY_CF_ACCOUNT",
 *       apiTokenEnvVar: "MY_CF_STREAM_KEY",
 *     }),
 *   ],
 * })
 * ```
 */
export function cloudflareStream(
	config: CloudflareStreamConfig,
): MediaProviderDescriptor<CloudflareStreamConfig> {
	return {
		id: "cloudflare-stream",
		name: "Cloudflare Stream",
		icon: STREAM_ICON,
		entrypoint: "@emdash-cms/cloudflare/media/stream-runtime",
		capabilities: {
			browse: true,
			search: true,
			upload: true,
			delete: true,
		},
		config,
	};
}
