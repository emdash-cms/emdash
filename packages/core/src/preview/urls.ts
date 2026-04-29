/**
 * Preview URL generation
 *
 * Creates preview URLs that include a signed token for accessing draft content.
 */

import { generatePreviewToken } from "./tokens.js";

/**
 * Options for generating a preview URL
 */
export interface GetPreviewUrlOptions {
	/** Collection slug (e.g., "posts") */
	collection: string;
	/** Content ID or slug */
	id: string;
	/** Secret key for signing the token */
	secret: string;
	/** How long the preview URL is valid. Default: "1h" */
	expiresIn?: string | number;
	/** Base URL of the site. If not provided, returns a relative URL. */
	baseUrl?: string;
	/**
	 * Custom path pattern. Supports `{collection}`, `{id}` and `{locale}`
	 * placeholders. Default: `"/{collection}/{id}"`.
	 */
	pathPattern?: string;
	/**
	 * Locale segment substituted for the `{locale}` placeholder in `pathPattern`.
	 * Pass an empty string to omit the locale prefix (e.g. for the default locale
	 * when `prefixDefaultLocale` is `false`); adjacent slashes left by an empty
	 * value are collapsed and any trailing slash is trimmed.
	 */
	locale?: string;
}

/**
 * Generate a preview URL for content
 *
 * The URL includes a `_preview` query parameter with a signed token.
 *
 * @example
 * ```ts
 * const url = await getPreviewUrl({
 *   collection: "posts",
 *   id: "hello-world",
 *   secret: process.env.PREVIEW_SECRET!,
 * });
 * // Returns: /posts/hello-world?_preview=eyJj...
 *
 * // With base URL:
 * const fullUrl = await getPreviewUrl({
 *   collection: "posts",
 *   id: "hello-world",
 *   secret: process.env.PREVIEW_SECRET!,
 *   baseUrl: "https://example.com",
 * });
 * // Returns: https://example.com/posts/hello-world?_preview=eyJj...
 *
 * // Custom path pattern:
 * const customUrl = await getPreviewUrl({
 *   collection: "posts",
 *   id: "hello-world",
 *   secret: process.env.PREVIEW_SECRET!,
 *   pathPattern: "/blog/{id}",
 * });
 * // Returns: /blog/hello-world?_preview=eyJj...
 * ```
 */
export async function getPreviewUrl(options: GetPreviewUrlOptions): Promise<string> {
	const {
		collection,
		id,
		secret,
		expiresIn = "1h",
		baseUrl,
		pathPattern = "/{collection}/{id}",
		locale = "",
	} = options;

	// Generate the signed token
	const token = await generatePreviewToken({
		contentId: `${collection}:${id}`,
		expiresIn,
		secret,
	});

	// Build the path. `{locale}` may resolve to an empty string (default locale
	// without a prefix); collapse the resulting double slashes and trim a
	// trailing slash so the URL stays clean.
	let path = pathPattern
		.replace("{collection}", collection)
		.replace("{id}", id)
		.replace("{locale}", locale);
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

	// Add token as query parameter
	const url = new URL(path, baseUrl || "http://placeholder");
	url.searchParams.set("_preview", token);

	// Return relative URL if no baseUrl provided
	if (!baseUrl) {
		return `${url.pathname}${url.search}`;
	}

	return url.toString();
}

/**
 * Build a preview URL from a token (when you already have the token)
 *
 * @example
 * ```ts
 * const url = buildPreviewUrl({
 *   path: "/posts/hello-world",
 *   token: existingToken,
 * });
 * ```
 */
export function buildPreviewUrl(options: {
	path: string;
	token: string;
	baseUrl?: string;
}): string {
	const { path, token, baseUrl } = options;

	const url = new URL(path, baseUrl || "http://placeholder");
	url.searchParams.set("_preview", token);

	if (!baseUrl) {
		return `${url.pathname}${url.search}`;
	}

	return url.toString();
}
