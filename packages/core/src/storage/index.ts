/**
 * Storage Layer
 *
 * S3-compatible storage abstraction for media uploads.
 * Supports R2, AWS S3, Minio, and local filesystem.
 */

// Types
export type {
	Storage,
	StorageDescriptor,
	S3StorageConfig,
	LocalStorageConfig,
	UploadResult,
	DownloadResult,
	DownloadOptions,
	ByteRange,
	ListResult,
	ListOptions,
	FileInfo,
	SignedUploadUrl,
	SignedUploadOptions,
	CreateStorageFn,
} from "./types.js";

export { EmDashStorageError } from "./types.js";

// Implementations (for direct import if needed)
export { S3Storage } from "./s3.js";
export { LocalStorage } from "./local.js";
