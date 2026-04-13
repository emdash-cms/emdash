/**
 * Storage Adapter Types
 *
 * Adapters use a serializable descriptor pattern:
 * - Config-time function returns { entrypoint, config }
 * - Runtime loads entrypoint and calls createStorage(config)
 *
 * Each adapter is responsible for accessing its own bindings.
 * For Cloudflare (R2), use `@emdash-cms/cloudflare` package.
 */

import type { Storage } from "../../index.js";

/**
 * Serializable storage configuration descriptor
 */
export interface StorageDescriptor {
	/** Module path exporting createStorage function */
	entrypoint: string;
	/** Serializable config passed to createStorage at runtime */
	config: unknown;
}

/**
 * The function signature that storage entrypoints must export
 *
 * Each adapter accesses its own bindings directly:
 * - S3: uses credentials from config
 * - Local: uses filesystem path from config
 * - R2: use @emdash-cms/cloudflare package
 */
export type CreateStorageFn = (config: Record<string, unknown>) => Storage;

/**
 * S3-compatible storage configuration
 */
export interface S3StorageConfig {
	/** S3 endpoint URL */
	endpoint: string;
	/** Bucket name */
	bucket: string;
	/**
	 * Access key ID.
	 * May be resolved from the `S3_ACCESS_KEY_ID` env var at runtime on Node.
	 * Must be provided together with `secretAccessKey`, or both omitted.
	 */
	accessKeyId?: string;
	/**
	 * Secret access key.
	 * May be resolved from the `S3_SECRET_ACCESS_KEY` env var at runtime on Node.
	 * Must be provided together with `accessKeyId`, or both omitted.
	 */
	secretAccessKey?: string;
	/** Optional region (defaults to "auto") */
	region?: string;
	/** Optional public URL prefix for CDN */
	publicUrl?: string;
}

/**
 * Local filesystem storage configuration
 */
export interface LocalStorageConfig {
	/** Directory path for storing files */
	directory: string;
	/** Base URL for serving files */
	baseUrl: string;
}
