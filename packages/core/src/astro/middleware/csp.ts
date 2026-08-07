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
import type { Storage } from "../../storage/types.js";
import type { StorageDescriptor } from "../storage/types.js";

/** Entrypoint constant used by the `s3()` adapter (see `astro/storage/adapters.ts`). */
const S3_ADAPTER_ENTRYPOINT = "emdash/storage/s3";

/**
 * Storage entrypoints are free to shape their config however they like, so
 * `endpoint` isn't a known field on `StorageDescriptor["config"]` -- only
 * S3-compatible adapters (R2, S3, Minio, ...) set it. Anything else (e.g.
 * local filesystem storage) simply has no `endpoint` to allow.
 *
 * The `s3()` adapter resolves any field omitted from its config -- including
 * `endpoint` -- from the matching `S3_*` env var at runtime (see
 * `storage/s3.ts`'s `resolveS3Config`). A site configured as `s3({ ... })`
 * with only `S3_ENDPOINT` set has no `endpoint` in the descriptor's config,
 * so fall back to that env var for S3-adapter storage. Custom adapters can
 * expose their runtime upload origin through `getClientUploadOrigin()`.
 */
export function getConfiguredStorageEndpoint(
	storage: StorageDescriptor | undefined,
	runtimeStorage?: Pick<Storage, "getClientUploadOrigin"> | null,
): string | undefined {
	const config = storage?.config;
	if (typeof config === "object" && config !== null && "endpoint" in config) {
		const endpoint = config.endpoint;
		if (typeof endpoint === "string") return endpoint;
	}

	if (storage?.entrypoint === S3_ADAPTER_ENTRYPOINT) {
		const envEndpoint =
			typeof process !== "undefined" && process.env ? process.env.S3_ENDPOINT : undefined;
		if (envEndpoint) return envEndpoint;
	}

	return runtimeStorage?.getClientUploadOrigin?.();
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
