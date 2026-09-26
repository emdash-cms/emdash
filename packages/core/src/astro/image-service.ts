/**
 * Runtime helpers for deciding whether Astro's configured image service can
 * produce browser-renderable HEIC renditions.
 */

import {
	resolveExternalImageServiceUrl,
	type ImageTransformOptions,
} from "../media/image-endpoint.js";
import { INTERNAL_MEDIA_PREFIX } from "../media/normalize.js";
import type { Storage } from "../storage/types.js";

const CLOUDFLARE_BINDING_SERVICE = "@astrojs/cloudflare/image-service-workerd";
const CLOUDFLARE_BINDING_ENDPOINTS = new Set([
	"@astrojs/cloudflare/image-transform-endpoint",
	"@emdash-cms/cloudflare/image-endpoint",
]);
const HEIC_PROBE_KEY = "emdash-heic-support-probe.heic";
const HEIC_PROBE_TRANSFORM: ImageTransformOptions = { width: 1, format: "webp" };
const HEIC_INPUT_FORMATS = new Set(["heic", "heif", "image/heic", "image/heif"]);

export function imageServiceConfigSupportsHeic(config: unknown): boolean {
	if (!config || typeof config !== "object") return false;
	const formats = (config as { supportedInputFormats?: unknown }).supportedInputFormats;
	return (
		Array.isArray(formats) &&
		formats.some(
			(format) => typeof format === "string" && HEIC_INPUT_FORMATS.has(format.toLowerCase()),
		)
	);
}

/** Resolve a storage public URL against the current site origin. */
export function resolveStorageImageSource(
	storage: Pick<Storage, "getPublicUrl">,
	key: string,
	requestUrl?: string | URL,
): string | null {
	const publicUrl = storage.getPublicUrl(key);
	let base: URL;
	try {
		base = requestUrl ? new URL(requestUrl) : new URL(publicUrl);
	} catch {
		return null;
	}

	try {
		const source = new URL(publicUrl, base.origin);
		if (source.protocol !== "http:" && source.protocol !== "https:") return null;
		if (source.origin === base.origin && source.pathname.startsWith(INTERNAL_MEDIA_PREFIX)) {
			return null;
		}
		return source.href;
	} catch {
		return null;
	}
}

/**
 * Check HEIC support without uploading a file.
 *
 * Cloudflare's workerd image-service module is intentionally a local
 * passthrough stub; the EmDash Cloudflare endpoint performs the real transform
 * with the Images binding, which accepts HEIC. On Node, local services such as
 * Sharp are treated as unsupported because their HEIC codec availability is
 * build-dependent. External services opt in by declaring HEIC in
 * `image.service.config.supportedInputFormats` and returning a distinct
 * transform URL for a `.heic` storage source. Requiring both prevents an
 * arbitrary URL-rewriting service from accepting uploads it cannot decode.
 */
export async function configuredImageServiceSupportsHeic(
	storage: Pick<Storage, "getPublicUrl">,
	requestUrl?: string | URL,
): Promise<boolean> {
	try {
		// Keep the Astro virtual module lazy so importing ordinary media routes in
		// Node/Vitest does not require an active Astro build context.
		// @ts-ignore - astro:assets is resolved by the consumer's Astro build
		const { getConfiguredImageService, imageConfig } = await import("astro:assets");

		if (imageConfig.service.entrypoint === CLOUDFLARE_BINDING_SERVICE) {
			return (
				typeof imageConfig.endpoint.entrypoint === "string" &&
				CLOUDFLARE_BINDING_ENDPOINTS.has(imageConfig.endpoint.entrypoint)
			);
		}

		const service = await getConfiguredImageService();
		if ("transform" in service) return false;
		if (!imageServiceConfigSupportsHeic(imageConfig.service.config)) return false;

		const sourceUrl = resolveStorageImageSource(storage, HEIC_PROBE_KEY, requestUrl);
		if (!sourceUrl) return false;
		const requestOrigin = requestUrl ? new URL(requestUrl).origin : new URL(sourceUrl).origin;
		return (
			(await resolveExternalImageServiceUrl(
				service,
				imageConfig,
				sourceUrl,
				HEIC_PROBE_TRANSFORM,
				requestOrigin,
			)) !== null
		);
	} catch {
		return false;
	}
}
