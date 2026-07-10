/**
 * Cloudflare Images Runtime Module
 *
 * This module is imported at runtime by the media provider system.
 * It contains the actual provider implementation that interacts with the Cloudflare API.
 */

import { env } from "cloudflare:workers";
import type {
	MediaProvider,
	MediaListOptions,
	MediaValue,
	EmbedOptions,
	EmbedResult,
	CreateMediaProviderFn,
} from "emdash/media";

import type { CloudflareImagesConfig } from "./images.js";

/** Safely extract a number from an unknown value */
function toNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/**
 * Resolve a config value, checking env var if direct value not provided
 */
function resolveEnvValue(
	directValue: string | undefined,
	envVarName: string | undefined,
	defaultEnvVar: string,
	serviceName: string,
): string {
	if (directValue) return directValue;
	const envVar = envVarName || defaultEnvVar;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object
	const value = (env as Record<string, string | undefined>)[envVar];
	if (!value) {
		throw new Error(
			`${serviceName}: Missing ${envVar}. Set it as an environment variable or provide it directly in config.`,
		);
	}
	return value;
}

/**
 * Runtime implementation for Cloudflare Images provider
 */
export const createMediaProvider: CreateMediaProviderFn<CloudflareImagesConfig> = (config) => {
	const { deliveryDomain, defaultVariant = "public" } = config;

	// Lazy getters - resolve env vars at request time, not module init time
	const getAccountId = () =>
		resolveEnvValue(config.accountId, config.accountIdEnvVar, "CF_ACCOUNT_ID", "Cloudflare Images");
	const getAccountHash = () =>
		resolveEnvValue(
			config.accountHash,
			config.accountHashEnvVar,
			"CF_IMAGES_ACCOUNT_HASH",
			"Cloudflare Images",
		);
	const getApiToken = () =>
		resolveEnvValue(config.apiToken, config.apiTokenEnvVar, "CF_IMAGES_TOKEN", "Cloudflare Images");
	const getApiBase = () =>
		`https://api.cloudflare.com/client/v4/accounts/${getAccountId()}/images/v1`;
	const getHeaders = () => ({ Authorization: `Bearer ${getApiToken()}` });
	const getDeliveryBase = () =>
		deliveryDomain ? `https://${deliveryDomain}` : "https://imagedelivery.net";

	// Build a delivery URL with flexible variant transforms
	const buildUrl = (imageId: string, transforms?: { w?: number; h?: number; fit?: string }) => {
		const base = `${getDeliveryBase()}/${getAccountHash()}/${imageId}`;
		if (!transforms || Object.keys(transforms).length === 0) {
			return `${base}/${defaultVariant}`;
		}
		const parts: string[] = [];
		if (transforms.w) parts.push(`w=${transforms.w}`);
		if (transforms.h) parts.push(`h=${transforms.h}`);
		if (transforms.fit) parts.push(`fit=${transforms.fit}`);
		return `${base}/${parts.join(",")}`;
	};

	// Fetch image dimensions via the format=json delivery endpoint
	// This is a public endpoint that doesn't require authentication
	const fetchDimensions = async (
		imageId: string,
	): Promise<{ width: number; height: number } | null> => {
		const url = `${getDeliveryBase()}/${getAccountHash()}/${imageId}/format=json`;
		try {
			const response = await fetch(url);
			if (!response.ok) return null;
			const data: ImageJsonResponse = await response.json();
			return { width: data.width, height: data.height };
		} catch {
			return null;
		}
	};

	const provider: MediaProvider = {
		async list(options: MediaListOptions) {
			const apiBase = getApiBase();
			const headers = getHeaders();

			const params = new URLSearchParams();
			if (options.cursor) {
				params.set("continuation_token", options.cursor);
			}
			if (options.limit) {
				params.set("per_page", String(options.limit));
			}

			const url = `${apiBase}?${params}`;
			const response = await fetch(url, { headers });

			if (!response.ok) {
				throw new Error(`Cloudflare Images API error: ${response.status}`);
			}

			const data: CloudflareImagesListResponse = await response.json();

			if (!data.success) {
				throw new Error(
					`Cloudflare Images API error: ${data.errors?.[0]?.message || "Unknown error"}`,
				);
			}

			// Filter out images that require signed URLs (not supported yet)
			const publicImages = data.result.images.filter((img) => !img.requireSignedURLs);

			// Fetch dimensions for all images in parallel
			const dimensionsMap = new Map<string, { width: number; height: number }>();
			const dimensionResults = await Promise.all(
				publicImages.map(async (img) => {
					const dims = await fetchDimensions(img.id);
					return { id: img.id, dims };
				}),
			);
			for (const { id, dims } of dimensionResults) {
				if (dims) dimensionsMap.set(id, dims);
			}

			return {
				items: publicImages.map((img) => {
					const dims = dimensionsMap.get(img.id);
					return {
						id: img.id,
						filename: img.filename || img.id,
						mimeType: "image/jpeg", // CF Images doesn't expose original mime type
						width: dims?.width ?? toNumber(img.meta?.width),
						height: dims?.height ?? toNumber(img.meta?.height),
						// Use 400px wide preview for grid thumbnails (good for 2x retina on ~200px grid)
						previewUrl: buildUrl(img.id, { w: 400, fit: "scale-down" }),
						meta: {
							variants: img.variants,
							uploaded: img.uploaded,
						},
					};
				}),
				nextCursor: data.result.continuation_token || undefined,
			};
		},

		async get(id: string) {
			const apiBase = getApiBase();
			const headers = getHeaders();

			const url = `${apiBase}/${id}`;
			const response = await fetch(url, { headers });

			if (!response.ok) {
				if (response.status === 404) return null;
				throw new Error(`Cloudflare Images API error: ${response.status}`);
			}

			const data: CloudflareImageResponse = await response.json();

			if (!data.success) {
				return null;
			}

			const img = data.result;

			// Don't return images that require signed URLs (not supported yet)
			if (img.requireSignedURLs) {
				return null;
			}

			// Fetch dimensions via format=json endpoint
			const dims = await fetchDimensions(img.id);

			return {
				id: img.id,
				filename: img.filename || img.id,
				mimeType: "image/jpeg",
				width: dims?.width ?? toNumber(img.meta?.width),
				height: dims?.height ?? toNumber(img.meta?.height),
				// Use larger preview for detail view
				previewUrl: buildUrl(img.id, { w: 800, fit: "scale-down" }),
				meta: {
					variants: img.variants,
					uploaded: img.uploaded,
				},
			};
		},

		async upload(input) {
			const apiBase = getApiBase();
			const apiToken = getApiToken();

			const formData = new FormData();
			formData.append("file", input.file, input.filename);

			// Ensure uploaded images are public (don't require signed URLs)
			formData.append("requireSignedURLs", "false");

			// Add metadata if provided
			const metadata: Record<string, string> = {};
			if (input.alt) {
				metadata.alt = input.alt;
			}
			if (Object.keys(metadata).length > 0) {
				formData.append("metadata", JSON.stringify(metadata));
			}

			const response = await fetch(apiBase, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					// Don't set Content-Type - let browser set it with boundary
				},
				body: formData,
			});

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Cloudflare Images upload failed: ${error}`);
			}

			const data: CloudflareImageResponse = await response.json();

			if (!data.success) {
				throw new Error(
					`Cloudflare Images upload failed: ${data.errors?.[0]?.message || "Unknown error"}`,
				);
			}

			const img = data.result;
			return {
				id: img.id,
				filename: img.filename || input.filename,
				mimeType: "image/jpeg",
				width: toNumber(img.meta?.width),
				height: toNumber(img.meta?.height),
				previewUrl: buildUrl(img.id, { w: 400, fit: "scale-down" }),
				meta: {
					variants: img.variants,
					uploaded: img.uploaded,
				},
			};
		},

		async delete(id: string) {
			const apiBase = getApiBase();
			const headers = getHeaders();

			const response = await fetch(`${apiBase}/${id}`, {
				method: "DELETE",
				headers,
			});

			if (!response.ok && response.status !== 404) {
				throw new Error(`Cloudflare Images delete failed: ${response.status}`);
			}
		},

		getEmbed(value: MediaValue, options?: EmbedOptions): EmbedResult {
			const accountHash = getAccountHash();
			const deliveryBase = getDeliveryBase();
			const baseUrl = `${deliveryBase}/${accountHash}/${value.id}`;

			// Helper to build URL with transforms
			const buildSrc = (opts: { width?: number; height?: number; format?: string }) => {
				const t: string[] = [];
				if (opts.width) t.push(`w=${opts.width}`);
				if (opts.height) t.push(`h=${opts.height}`);
				if (opts.format) t.push(`f=${opts.format}`);
				t.push("fit=scale-down");
				return `${baseUrl}/${t.join(",")}`;
			};

			// Build src URL - always include transforms (CF Images requires a variant)
			const width = options?.width ?? value.width ?? 1200;
			const height = options?.height ?? value.height;
			const src = buildSrc({ width, height, format: options?.format });

			return {
				type: "image",
				src,
				width: options?.width ?? value.width,
				height: options?.height ?? value.height,
				alt: value.alt,
				// Provide getSrc for dynamic resizing (e.g., responsive images)
				getSrc: buildSrc,
			};
		},

		getThumbnailUrl(id: string, _mimeType?: string, options?: { width?: number; height?: number }) {
			// For images, return a sized delivery URL
			const width = options?.width || 400;
			const height = options?.height;
			return buildUrl(id, { w: width, h: height, fit: "scale-down" });
		},
	};

	return provider;
};

// Cloudflare API response types
interface CloudflareImagesListResponse {
	success: boolean;
	errors?: Array<{ message: string }>;
	result: {
		images: CloudflareImage[];
		continuation_token?: string;
	};
}

interface CloudflareImageResponse {
	success: boolean;
	errors?: Array<{ message: string }>;
	result: CloudflareImage;
}

interface CloudflareImage {
	id: string;
	filename?: string;
	uploaded: string;
	requireSignedURLs: boolean;
	variants: string[];
	meta?: Record<string, unknown>;
}

// Response from format=json delivery endpoint
interface ImageJsonResponse {
	width: number;
	height: number;
	original: {
		file_size: number;
		width: number;
		height: number;
		format: string;
	};
}
