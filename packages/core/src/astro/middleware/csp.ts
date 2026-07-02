/**
 * Strict Content-Security-Policy for /_emdash routes (admin + API).
 *
 * Applied via middleware header rather than Astro's built-in CSP because
 * Astro's auto-hashing defeats 'unsafe-inline' (CSP3 ignores 'unsafe-inline'
 * when hashes are present), which would break user-facing pages.
 *
 * img-src allows any HTTPS origin because the admin renders user content that
 * may reference external images (migrations, external hosting, embeds).
 * Plugin security does not rely on img-src -- plugins run in V8 isolates with
 * no DOM access. connect-src stays at 'self' unless the experimental registry
 * and/or the configured storage endpoint (for direct-to-S3 signed uploads)
 * are configured, in which case those origins are allowed too.
 */
import type { RegistryConfigInput } from "../../registry/types.js";
import type { StorageDescriptor } from "../storage/types.js";

/**
 * Storage entrypoints are free to shape their config however they like, so
 * `endpoint` isn't a known field on `StorageDescriptor["config"]` -- only
 * S3-compatible adapters (R2, S3, Minio, ...) set it. Anything else (e.g.
 * local filesystem storage) simply has no `endpoint` to allow.
 */
export function getConfiguredStorageEndpoint(
	storage: StorageDescriptor | undefined,
): string | undefined {
	const config = storage?.config;
	if (typeof config !== "object" || config === null) return undefined;
	const endpoint = (config as Record<string, unknown>).endpoint;
	return typeof endpoint === "string" ? endpoint : undefined;
}

function getRegistryAggregatorOrigin(
	registry: RegistryConfigInput | undefined,
): string | undefined {
	const aggregatorUrl = typeof registry === "string" ? registry : registry?.aggregatorUrl;
	if (!aggregatorUrl) return undefined;

	try {
		const url = new URL(aggregatorUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function getHttpOrigin(rawUrl: string | undefined): string | undefined {
	if (!rawUrl) return undefined;

	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function buildEmDashCsp(registry?: RegistryConfigInput, storageEndpoint?: string): string {
	const connectSrc = ["connect-src 'self'"];
	const origins = new Set<string>();
	const registryAggregatorOrigin = getRegistryAggregatorOrigin(registry);
	if (registryAggregatorOrigin) origins.add(registryAggregatorOrigin);
	const storageOrigin = getHttpOrigin(storageEndpoint);
	if (storageOrigin) origins.add(storageOrigin);
	connectSrc.push(...origins);

	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		connectSrc.join(" "),
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' https: data: blob:",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
