/**
 * S3-Compatible Storage Implementation
 *
 * Uses the AWS SDK v3 for S3 operations.
 * Works with AWS S3, Cloudflare R2, Minio, and other S3-compatible services.
 */

import {
	S3Client,
	type S3ClientConfig,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	type ListObjectsV2Response,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

import type {
	Storage,
	S3StorageConfig,
	UploadResult,
	DownloadResult,
	ListResult,
	ListOptions,
	SignedUploadUrl,
	SignedUploadOptions,
} from "./types.js";
import { EmDashStorageError } from "./types.js";

const ENV_KEYS = {
	endpoint: "S3_ENDPOINT",
	bucket: "S3_BUCKET",
	accessKeyId: "S3_ACCESS_KEY_ID",
	secretAccessKey: "S3_SECRET_ACCESS_KEY",
	region: "S3_REGION",
	publicUrl: "S3_PUBLIC_URL",
} as const satisfies Record<keyof S3StorageConfig, string>;

function fail(msg: string): never {
	throw new EmDashStorageError(msg, "MISSING_S3_CONFIG");
}

const s3ConfigSchema = z.object({
	endpoint: z.url({ protocol: /^https?$/, error: "is not a valid http/https URL" }).optional(),
	bucket: z.string().optional(),
	accessKeyId: z.string().optional(),
	secretAccessKey: z.string().optional(),
	region: z.string().optional(),
	publicUrl: z.string().optional(),
});

function isConfigKey(key: unknown): key is keyof S3StorageConfig {
	return typeof key === "string" && key in ENV_KEYS;
}

/**
 * Build the merged config: for each field, use the explicit value if present,
 * otherwise fall back to the corresponding S3_* env var.  Validate once on the
 * final merged result so a malformed env var never breaks the build when the
 * caller provides that field explicitly.
 */
export function resolveS3Config(partial: Record<string, unknown>): S3StorageConfig {
	const raw: Record<string, unknown> = {};
	for (const [field, envKey] of Object.entries(ENV_KEYS)) {
		const explicit = partial[field];
		if (explicit !== undefined && explicit !== "") {
			raw[field] = explicit;
			continue;
		}
		const envVal = typeof process !== "undefined" && process.env ? process.env[envKey] : undefined;
		if (envVal !== undefined && envVal !== "") {
			raw[field] = envVal;
		}
	}

	const result = s3ConfigSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const pathKey = issue?.path[0];
		if (!issue || !isConfigKey(pathKey)) fail("S3 config validation failed");
		const fromExplicit = partial[pathKey] !== undefined && partial[pathKey] !== "";
		const label = fromExplicit ? `s3({ ${pathKey} })` : ENV_KEYS[pathKey];
		fail(`${label} ${issue.message}`);
	}
	const merged = result.data;

	const endpoint = merged.endpoint;
	const bucket = merged.bucket;
	if (!endpoint || !bucket) {
		const missing: string[] = [];
		if (!endpoint) missing.push(`endpoint: set ${ENV_KEYS.endpoint} or pass endpoint to s3({...})`);
		if (!bucket) missing.push(`bucket: set ${ENV_KEYS.bucket} or pass bucket to s3({...})`);
		fail(`missing required S3 config: ${missing.join("; ")}`);
	}
	const accessKeyId = merged.accessKeyId;
	const secretAccessKey = merged.secretAccessKey;
	if (accessKeyId && !secretAccessKey) {
		fail(
			`S3 credentials incomplete: accessKeyId is set but secretAccessKey is missing (set ${ENV_KEYS.secretAccessKey} or pass secretAccessKey to s3({...}))`,
		);
	}
	if (secretAccessKey && !accessKeyId) {
		fail(
			`S3 credentials incomplete: secretAccessKey is set but accessKeyId is missing (set ${ENV_KEYS.accessKeyId} or pass accessKeyId to s3({...}))`,
		);
	}

	return { ...merged, endpoint, bucket };
}

const TRAILING_SLASH_PATTERN = /\/$/;

/** Type guard for AWS SDK errors (have a `name` property) */
function hasErrorName(error: unknown): error is Error & { name: string } {
	return error instanceof Error && typeof error.name === "string";
}

/**
 * S3-compatible storage implementation
 */
export class S3Storage implements Storage {
	private client: S3Client;
	private bucket: string;
	private publicUrl?: string;
	private endpoint: string;

	constructor(config: S3StorageConfig) {
		this.bucket = config.bucket;
		this.publicUrl = config.publicUrl;
		this.endpoint = config.endpoint;

		// S3ClientConfig types `credentials` as required, but the SDK accepts
		// omitted credentials at runtime (falls back to the provider chain).
		/* eslint-disable typescript-eslint(no-unsafe-type-assertion) -- upstream @aws-sdk/client-s3 overstates required fields */
		const clientConfig = {
			endpoint: config.endpoint,
			region: config.region || "auto",
			// Required for R2 and some S3-compatible services
			forcePathStyle: true,
			...(config.accessKeyId && config.secretAccessKey
				? {
						credentials: {
							accessKeyId: config.accessKeyId,
							secretAccessKey: config.secretAccessKey,
						},
					}
				: {}),
		} as S3ClientConfig;
		/* eslint-enable typescript-eslint(no-unsafe-type-assertion) */
		this.client = new S3Client(clientConfig);
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}): Promise<UploadResult> {
		try {
			// Convert ReadableStream to Buffer if needed
			let body: Buffer | Uint8Array;
			if (options.body instanceof ReadableStream) {
				const chunks: Uint8Array[] = [];
				const reader = options.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				body = Buffer.concat(chunks);
			} else {
				body = options.body;
			}

			await this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: options.key,
					Body: body,
					ContentType: options.contentType,
				}),
			);

			return {
				key: options.key,
				url: this.getPublicUrl(options.key),
				size: body.length,
			};
		} catch (error) {
			throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED", error);
		}
	}

	async download(key: string): Promise<DownloadResult> {
		try {
			const response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);

			if (!response.Body) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			}

			// Convert SDK stream to web ReadableStream
			const body = response.Body.transformToWebStream();

			return {
				body,
				contentType: response.ContentType || "application/octet-stream",
				size: response.ContentLength || 0,
			};
		} catch (error) {
			if (
				error instanceof EmDashStorageError ||
				(hasErrorName(error) && error.name === "NoSuchKey")
			) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND", error);
			}
			throw new EmDashStorageError(`Failed to download file: ${key}`, "DOWNLOAD_FAILED", error);
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);
		} catch (error) {
			// S3 delete is idempotent, so we ignore "not found" errors
			if (!hasErrorName(error) || error.name !== "NoSuchKey") {
				throw new EmDashStorageError(`Failed to delete file: ${key}`, "DELETE_FAILED", error);
			}
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);
			return true;
		} catch (error) {
			if (hasErrorName(error) && error.name === "NotFound") {
				return false;
			}
			throw new EmDashStorageError(`Failed to check file existence: ${key}`, "HEAD_FAILED", error);
		}
	}

	async list(options: ListOptions = {}): Promise<ListResult> {
		try {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- S3 client.send returns generic output; narrowing to ListObjectsV2Response
			const response = (await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: options.prefix,
					MaxKeys: options.limit,
					ContinuationToken: options.cursor,
				}),
			)) as ListObjectsV2Response;

			return {
				files: (response.Contents || []).map(
					(item: { Key?: string; Size?: number; LastModified?: Date; ETag?: string }) => ({
						key: item.Key!,
						size: item.Size || 0,
						lastModified: item.LastModified || new Date(),
						etag: item.ETag,
					}),
				),
				nextCursor: response.NextContinuationToken,
			};
		} catch (error) {
			throw new EmDashStorageError("Failed to list files", "LIST_FAILED", error);
		}
	}

	async getSignedUploadUrl(options: SignedUploadOptions): Promise<SignedUploadUrl> {
		try {
			const expiresIn = options.expiresIn || 3600; // 1 hour default

			const command = new PutObjectCommand({
				Bucket: this.bucket,
				Key: options.key,
				ContentType: options.contentType,
				ContentLength: options.size,
			});

			const url = await getSignedUrl(this.client, command, { expiresIn });

			const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

			return {
				url,
				method: "PUT",
				headers: {
					"Content-Type": options.contentType,
					...(options.size ? { "Content-Length": String(options.size) } : {}),
				},
				expiresAt,
			};
		} catch (error) {
			throw new EmDashStorageError(
				`Failed to generate signed URL for: ${options.key}`,
				"SIGNED_URL_FAILED",
				error,
			);
		}
	}

	getPublicUrl(key: string): string {
		if (this.publicUrl) {
			return `${this.publicUrl.replace(TRAILING_SLASH_PATTERN, "")}/${key}`;
		}
		// No public URL configured; defer to the /_emdash/api/media/file route.
		return `/_emdash/api/media/file/${key}`;
	}
}

/**
 * Create S3 storage adapter
 * This is the factory function called at runtime.
 * Config fields are merged with S3_* env vars; env vars fill in any missing fields.
 */
export function createStorage(config: Record<string, unknown>): Storage {
	return new S3Storage(resolveS3Config(config));
}
