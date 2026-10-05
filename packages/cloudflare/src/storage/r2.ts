/**
 * Cloudflare R2 Storage Implementation - RUNTIME ENTRY
 *
 * Uses R2 bindings directly when running on Cloudflare Workers.
 * This avoids the AWS SDK overhead and works with the native R2 API.
 *
 * This module imports directly from cloudflare:workers to access R2 bindings.
 * Do NOT import this at config time - use { r2 } from "@emdash-cms/cloudflare" instead.
 *
 * For Astro 6 / Cloudflare adapter v13+:
 * - Bindings are accessed via `import { env } from 'cloudflare:workers'`
 */

import { env } from "cloudflare:workers";
import type {
	Storage,
	UploadResult,
	ByteRange,
	DownloadOptions,
	DownloadResult,
	ListResult,
	ListOptions,
	SignedUploadUrl,
	SignedUploadOptions,
} from "emdash";
import { EmDashStorageError } from "emdash";

/** Regex to remove trailing slashes from URLs */
const TRAILING_SLASH_REGEX = /\/$/;

/** The bytes of an object of `size` bytes that an R2 range covers */
function servedRange(
	{ offset = 0, length, suffix }: { offset?: number; length?: number; suffix?: number },
	size: number,
): { offset: number; length: number } {
	if (suffix !== undefined) {
		const tail = Math.min(suffix, size);
		return { offset: size - tail, length: tail };
	}
	return { offset, length: Math.min(length ?? size, size - offset) };
}

/**
 * R2 Storage implementation using native bindings
 */
export class R2Storage implements Storage {
	private bucket: R2Bucket;
	private publicUrl?: string;

	constructor(bucket: R2Bucket, publicUrl?: string) {
		this.bucket = bucket;
		this.publicUrl = publicUrl;
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
		cacheControl?: string;
	}): Promise<UploadResult> {
		try {
			const result = await this.bucket.put(options.key, options.body, {
				httpMetadata: {
					contentType: options.contentType,
					cacheControl: options.cacheControl,
				},
			});

			if (!result) {
				throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED");
			}

			return {
				key: options.key,
				url: this.getPublicUrl(options.key),
				size: result.size,
			};
		} catch (error) {
			if (error instanceof EmDashStorageError) throw error;
			throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED", error);
		}
	}

	async download(key: string, options: DownloadOptions = {}): Promise<DownloadResult> {
		const { range } = options;
		try {
			const ranged = range ? await this.getRange(key, range) : undefined;
			const object = ranged === undefined ? await this.bucket.get(key) : ranged;

			if (!object) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			}

			// R2ObjectBody has the body property — use it as a type guard
			if (!("body" in object) || !object.body) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			}

			return {
				body: object.body,
				contentType: object.httpMetadata?.contentType || "application/octet-stream",
				size: object.size,
				// R2 may not report the range it read, which is the requested one clamped to the object
				...(range && ranged && { range: servedRange(ranged.range ?? range, ranged.size) }),
			};
		} catch (error) {
			if (error instanceof EmDashStorageError) throw error;
			throw new EmDashStorageError(`Failed to download file: ${key}`, "DOWNLOAD_FAILED", error);
		}
	}

	/**
	 * Resolves to undefined when the ranged read fails, so the caller reads the
	 * whole object instead. A range past the end of the object doesn't always
	 * fail with R2's invalid-range error, and a persistent failure fails the
	 * whole read too.
	 */
	private async getRange(key: string, range: ByteRange): Promise<R2ObjectBody | null | undefined> {
		try {
			return await this.bucket.get(key, { range });
		} catch {
			return undefined;
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.bucket.delete(key);
		} catch (error) {
			// R2 delete is idempotent
			throw new EmDashStorageError(`Failed to delete file: ${key}`, "DELETE_FAILED", error);
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			const object = await this.bucket.head(key);
			return object !== null;
		} catch (error) {
			throw new EmDashStorageError(`Failed to check file existence: ${key}`, "HEAD_FAILED", error);
		}
	}

	async list(options: ListOptions = {}): Promise<ListResult> {
		try {
			const response = await this.bucket.list({
				prefix: options.prefix,
				limit: options.limit,
				cursor: options.cursor,
			});

			return {
				files: response.objects.map((item) => ({
					key: item.key,
					size: item.size,
					lastModified: item.uploaded,
					etag: item.etag,
				})),
				nextCursor: response.truncated ? response.cursor : undefined,
			};
		} catch (error) {
			throw new EmDashStorageError("Failed to list files", "LIST_FAILED", error);
		}
	}

	async getSignedUploadUrl(_options: SignedUploadOptions): Promise<SignedUploadUrl> {
		// R2 doesn't support pre-signed URLs in the same way as S3
		// For R2, uploads go through the Worker
		// This method is here for interface compatibility but throws an error
		throw new EmDashStorageError(
			"R2 bindings do not support pre-signed upload URLs. " +
				"Use the S3 API with R2 credentials for signed URL support, " +
				"or upload through the Worker.",
			"NOT_SUPPORTED",
		);
	}

	getPublicUrl(key: string): string {
		if (this.publicUrl) {
			return `${this.publicUrl.replace(TRAILING_SLASH_REGEX, "")}/${key}`;
		}
		// Without a public URL, we can't generate one for R2 bindings
		// Return a relative path that should be served through the API
		return `/_emdash/api/media/file/${key}`;
	}
}

/**
 * Create R2 storage adapter
 * This is the factory function called at runtime
 *
 * Uses cloudflare:workers to access bindings directly.
 */
export function createStorage(config: Record<string, unknown>): Storage {
	const binding = typeof config.binding === "string" ? config.binding : "";
	const publicUrl = typeof config.publicUrl === "string" ? config.publicUrl : undefined;

	if (!binding) {
		throw new EmDashStorageError(
			`R2 binding name is required in storage config.`,
			"BINDING_NOT_FOUND",
		);
	}

	// env from cloudflare:workers doesn't have an index signature, so cast is needed
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- R2Bucket binding accessed from untyped env object
	const bucket = (env as Record<string, unknown>)[binding] as R2Bucket | undefined;

	if (!bucket) {
		throw new EmDashStorageError(
			`R2 binding "${binding}" not found. ` +
				`Make sure the binding is defined in wrangler.jsonc and ` +
				`you're running on Cloudflare Workers.\n\n` +
				`Example wrangler.jsonc:\n` +
				`{\n` +
				`  "r2_buckets": [{\n` +
				`    "binding": "${binding}",\n` +
				`    "bucket_name": "my-bucket"\n` +
				`  }]\n` +
				`}`,
			"BINDING_NOT_FOUND",
		);
	}

	return new R2Storage(bucket, publicUrl);
}
