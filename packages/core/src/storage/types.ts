/**
 * Storage Layer Types
 *
 * Defines the interface for S3-compatible storage backends.
 * Works with R2, AWS S3, Minio, and other S3-compatible services.
 */

/**
 * Storage configuration for S3-compatible backends
 */
export interface S3StorageConfig {
	/** S3 endpoint URL (e.g., "https://xxx.r2.cloudflarestorage.com") */
	endpoint: string;
	/** Bucket name */
	bucket: string;
	/**
	 * AWS access key ID.
	 * May be resolved from the `S3_ACCESS_KEY_ID` env var at runtime on Node.
	 * Must be provided together with `secretAccessKey`, or both omitted.
	 */
	accessKeyId?: string;
	/**
	 * AWS secret access key.
	 * May be resolved from the `S3_SECRET_ACCESS_KEY` env var at runtime on Node.
	 * Must be provided together with `accessKeyId`, or both omitted.
	 */
	secretAccessKey?: string;
	/** Optional region (defaults to "auto") */
	region?: string;
	/** Optional public URL prefix for generated URLs (e.g., CDN URL) */
	publicUrl?: string;
}

/**
 * Local filesystem storage for development
 */
export interface LocalStorageConfig {
	/** Directory path for storing files */
	directory: string;
	/** Base URL for serving files */
	baseUrl: string;
}

/**
 * Storage adapter descriptor (serializable config)
 */
export interface StorageDescriptor {
	/** Module path exporting createStorage function */
	entrypoint: string;
	/** Serializable config passed to createStorage at runtime */
	config: Record<string, unknown>;
}

/**
 * Factory function signature for storage adapters
 *
 * Each adapter accesses its own bindings directly:
 * - R2: imports from cloudflare:workers
 * - S3: uses credentials from config
 * - Local: uses filesystem path from config
 */
export type CreateStorageFn = (config: Record<string, unknown>) => Storage;

/**
 * Upload result
 */
export interface UploadResult {
	/** Storage key (path within bucket) */
	key: string;
	/** Public URL to access the file */
	url: string;
	/** File size in bytes */
	size: number;
}

/**
 * Download result
 */
export interface DownloadResult {
	/** File content as readable stream */
	body: ReadableStream<Uint8Array>;
	/** MIME type */
	contentType: string;
	/** File size in bytes */
	size: number;
}

/**
 * Signed URL for direct upload
 */
export interface SignedUploadUrl {
	/** Signed URL for PUT request */
	url: string;
	/** HTTP method (always PUT) */
	method: "PUT";
	/** Headers to include in the upload request */
	headers: Record<string, string>;
	/** URL expiration time (ISO string) */
	expiresAt: string;
}

/**
 * Options for generating signed upload URL
 */
export interface SignedUploadOptions {
	/** Storage key (path within bucket) */
	key: string;
	/** MIME type of the file */
	contentType: string;
	/** File size in bytes (for content-length validation) */
	size?: number;
	/** URL expiration in seconds (default: 3600) */
	expiresIn?: number;
}

/**
 * File listing result
 */
export interface ListResult {
	/** List of files */
	files: FileInfo[];
	/** Cursor for next page (if more results) */
	nextCursor?: string;
}

/**
 * File info from listing
 */
export interface FileInfo {
	/** Storage key */
	key: string;
	/** File size in bytes */
	size: number;
	/** Last modified date */
	lastModified: Date;
	/** ETag (content hash) */
	etag?: string;
}

/**
 * Options for listing files
 */
export interface ListOptions {
	/** Filter by key prefix */
	prefix?: string;
	/** Maximum results per page */
	limit?: number;
	/** Cursor from previous list call */
	cursor?: string;
}

/**
 * Storage interface
 *
 * All storage backends must implement this interface.
 */
export interface Storage {
	/**
	 * Upload a file to storage
	 */
	upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}): Promise<UploadResult>;

	/**
	 * Download a file from storage
	 */
	download(key: string): Promise<DownloadResult>;

	/**
	 * Delete a file from storage
	 * Idempotent - does not throw if file doesn't exist
	 */
	delete(key: string): Promise<void>;

	/**
	 * Check if a file exists
	 */
	exists(key: string): Promise<boolean>;

	/**
	 * List files in storage
	 */
	list(options?: ListOptions): Promise<ListResult>;

	/**
	 * Generate a signed URL for direct upload
	 * Client uploads directly to storage, bypassing the server
	 */
	getSignedUploadUrl(options: SignedUploadOptions): Promise<SignedUploadUrl>;

	/**
	 * Get public URL for a file
	 */
	getPublicUrl(key: string): string;
}

/**
 * Storage error with additional context
 */
export class EmDashStorageError extends Error {
	constructor(
		message: string,
		public code: string,
		public override cause?: unknown,
	) {
		super(message);
		this.name = "EmDashStorageError";
	}
}
