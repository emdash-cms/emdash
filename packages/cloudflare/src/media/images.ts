/**
 * Cloudflare Images Media Provider
 *
 * Provides integration with Cloudflare Images for image hosting and transformation.
 *
 * Features:
 * - Browse uploaded images
 * - Upload new images
 * - Delete images
 * - URL-based image transformations (resize, format conversion, etc.)
 *
 * @see https://developers.cloudflare.com/images/
 */

import type { MediaProviderDescriptor } from "emdash/media";

/**
 * Cloudflare Images configuration
 *
 * `*EnvVar` options are resolved in order: the matching direct config value,
 * then a Cloudflare Workers binding of that name, then `process.env` (Node
 * adapter, where there is no Workers binding).
 */
export interface CloudflareImagesConfig {
	/**
	 * Cloudflare Account ID (for API calls)
	 * If not provided, reads from accountIdEnvVar at runtime
	 */
	accountId?: string;

	/**
	 * Environment variable name containing the Account ID
	 * @default "CF_ACCOUNT_ID"
	 */
	accountIdEnvVar?: string;

	/**
	 * Cloudflare Images Account Hash (for delivery URLs)
	 * This is different from the Account ID - find it in the Cloudflare dashboard
	 * under Images > Overview > "Account Hash"
	 * If not provided, reads from accountHashEnvVar at runtime
	 */
	accountHash?: string;

	/**
	 * Environment variable name containing the Account Hash
	 * @default "CF_IMAGES_ACCOUNT_HASH"
	 */
	accountHashEnvVar?: string;

	/**
	 * API Token with Images permissions
	 * If not provided, reads from apiTokenEnvVar at runtime
	 * Should have "Cloudflare Images: Read" and "Cloudflare Images: Edit" permissions
	 */
	apiToken?: string;

	/**
	 * Environment variable name containing the API token
	 * @default "CF_IMAGES_TOKEN"
	 */
	apiTokenEnvVar?: string;

	/**
	 * Custom delivery domain (optional)
	 * If not specified, uses imagedelivery.net
	 * @example "images.example.com"
	 */
	deliveryDomain?: string;

	/**
	 * Default variant to use for display
	 * @default "public"
	 */
	defaultVariant?: string;
}

// Cloudflare Images icon (inline SVG as data URL)
const IMAGES_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M56 11.92H8l-2 2v39.87l2 2h48l2-2V13.92l-2-2Zm-2 4v18.69l-8-6.55-2.62.08-5.08 4.68-5.43-4-2.47.08-14 11.7-6.4-4.4V15.92h44ZM10 51.79V41.08l5.3 3.7 2.42-.11L31.75 33l5.5 4 2.54-.14 5-4.63L54 39.77v12l-44 .02Z"/><path fill="#F63" d="M19.08 32.16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>')}`;

/**
 * Cloudflare Images media provider
 *
 * @example
 * ```ts
 * import { cloudflareImages } from "@emdash-cms/cloudflare";
 *
 * emdash({
 *   mediaProviders: [
 *     // Uses CF_ACCOUNT_ID and CF_IMAGES_TOKEN env vars by default
 *     cloudflareImages({}),
 *
 *     // Or with custom env var names
 *     cloudflareImages({
 *       accountIdEnvVar: "MY_CF_ACCOUNT",
 *       apiTokenEnvVar: "MY_CF_IMAGES_KEY",
 *     }),
 *   ],
 * })
 * ```
 */
export function cloudflareImages(
	config: CloudflareImagesConfig,
): MediaProviderDescriptor<CloudflareImagesConfig> {
	return {
		id: "cloudflare-images",
		name: "Cloudflare Images",
		icon: IMAGES_ICON,
		entrypoint: "@emdash-cms/cloudflare/media/images-runtime",
		capabilities: {
			browse: true,
			search: false, // Images API doesn't support search
			upload: true,
			delete: true,
		},
		config,
	};
}
