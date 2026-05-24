/**
 * Storage Adapter Functions
 *
 * These run at config time (astro.config.mjs) and return serializable descriptors.
 * The actual storage is created at runtime by loading the entrypoint.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import emdash, { s3, local } from "emdash/astro";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       storage: s3({
 *         endpoint: "https://xxx.r2.cloudflarestorage.com",
 *         bucket: "media",
 *         accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *         secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *       }),
 *       // or: storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
 *     }),
 *   ],
 * });
 * ```
 *
 * For Cloudflare R2 bindings, use `r2()` from `@emdash-cms/cloudflare`.
 */

import type { StorageDescriptor, S3StorageConfig, LocalStorageConfig } from "./types.js";

/**
 * S3-compatible storage adapter
 *
 * Works with AWS S3, Cloudflare R2 (via S3 API), MinIO, etc.
 *
 * Any field omitted here is resolved from the matching `S3_*` environment
 * variable when the container starts (`S3_ENDPOINT`, `S3_BUCKET`,
 * `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL`).
 * Explicit values always take precedence over env vars.
 *
 * Note: env var resolution reads `process.env` on Node at runtime.
 * Workers users should continue passing explicit values to `s3({...})`.
 *
 * @example
 * ```ts
 * // All fields from env (container deployments)
 * storage: s3()
 *
 * // Mix: CDN from config, credentials from env
 * storage: s3({ publicUrl: "https://cdn.example.com" })
 *
 * // All explicit (unchanged from before)
 * storage: s3({
 *   endpoint: "https://xxx.r2.cloudflarestorage.com",
 *   bucket: "media",
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID,
 *   secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
 * })
 * ```
 */
export function s3(config: Partial<S3StorageConfig> = {}): StorageDescriptor {
	return {
		entrypoint: "emdash/storage/s3",
		config,
	};
}

/**
 * Local filesystem storage adapter
 *
 * For development and testing. Stores files in a local directory.
 * Does NOT support signed upload URLs.
 *
 * @example
 * ```ts
 * storage: local({
 *   directory: "./uploads",
 *   baseUrl: "/_emdash/api/media/file",
 * })
 * ```
 */
export function local(config: LocalStorageConfig): StorageDescriptor {
	return {
		entrypoint: "emdash/storage/local",
		config,
	};
}
