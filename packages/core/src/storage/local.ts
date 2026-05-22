/**
 * Local Filesystem Storage Implementation
 *
 * For development and testing. Stores files in a local directory.
 */

import { createReadStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";

import mime from "mime/lite";

/** Type guard for Node.js ErrnoException */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

import type {
	Storage,
	LocalStorageConfig,
	UploadResult,
	DownloadResult,
	ListResult,
	ListOptions,
	SignedUploadUrl,
	SignedUploadOptions,
} from "./types.js";
import { EmDashStorageError } from "./types.js";

/** Pattern to remove leading slashes */
const LEADING_SLASH_PATTERN = /^\//;

/** Pattern to remove trailing slashes */
const TRAILING_SLASH_PATTERN = /\/$/;

/**
 * Local filesystem storage implementation
 */
export class LocalStorage implements Storage {
	/** Resolved absolute base directory for all stored files */
	private directory: string;
	private baseUrl: string;

	constructor(config: LocalStorageConfig) {
		this.directory = path.resolve(config.directory);
		this.baseUrl = config.baseUrl.replace(TRAILING_SLASH_PATTERN, "");
	}

	/**
	 * Resolve a storage key to an absolute file path, ensuring it stays
	 * within the configured storage directory. Uses path.resolve() for
	 * canonical resolution rather than regex stripping.
	 *
	 * @throws EmDashStorageError if the resolved path escapes the base directory
	 */
	private getFilePath(key: string): string {
		const normalizedKey = key.replace(LEADING_SLASH_PATTERN, "");
		const resolved = path.resolve(this.directory, normalizedKey);

		// Verify the resolved path is within the base directory
		if (!resolved.startsWith(this.directory + path.sep) && resolved !== this.directory) {
			throw new EmDashStorageError("Invalid file path", "INVALID_PATH");
		}

		return resolved;
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}): Promise<UploadResult> {
		try {
			const filePath = this.getFilePath(options.key);
			const dir = path.dirname(filePath);

			// Ensure directory exists
			await fs.mkdir(dir, { recursive: true });

			// Convert body to buffer
			let buffer: Buffer;
			if (options.body instanceof ReadableStream) {
				const chunks: Uint8Array[] = [];
				const reader = options.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				buffer = Buffer.concat(chunks);
			} else if (options.body instanceof Uint8Array) {
				buffer = Buffer.from(options.body);
			} else {
				buffer = options.body;
			}

			await fs.writeFile(filePath, buffer);

			return {
				key: options.key,
				url: this.getPublicUrl(options.key),
				size: buffer.length,
			};
		} catch (error) {
			throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED", error);
		}
	}

	async download(key: string): Promise<DownloadResult> {
		try {
			const filePath = this.getFilePath(key);

			if (!existsSync(filePath)) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			}

			const stat = await fs.stat(filePath);
			const nodeStream = createReadStream(filePath);

			// Convert Node.js stream to web ReadableStream
			// Readable.toWeb returns ReadableStream (which is ReadableStream<unknown>),
			// but Node ReadStreams produce Buffer/Uint8Array chunks
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Readable.toWeb returns ReadableStream<unknown>; Node ReadStreams produce Uint8Array chunks
			const webStream: ReadableStream<Uint8Array> = Readable.toWeb(
				nodeStream,
			) as ReadableStream<Uint8Array>;

			// Infer content type from extension
			const ext = path.extname(key).toLowerCase();
			const contentType = getContentType(ext);

			return {
				body: webStream,
				contentType,
				size: stat.size,
			};
		} catch (error) {
			if (error instanceof EmDashStorageError) throw error;
			throw new EmDashStorageError(`Failed to download file: ${key}`, "DOWNLOAD_FAILED", error);
		}
	}

	async delete(key: string): Promise<void> {
		try {
			const filePath = this.getFilePath(key);
			await fs.unlink(filePath);
		} catch (error) {
			// Ignore "file not found" errors (idempotent delete)
			if (!isNodeError(error) || error.code !== "ENOENT") {
				throw new EmDashStorageError(`Failed to delete file: ${key}`, "DELETE_FAILED", error);
			}
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			const filePath = this.getFilePath(key);
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	async list(options: ListOptions = {}): Promise<ListResult> {
		try {
			const prefix = options.prefix || "";
			const searchDir = path.resolve(this.directory, path.dirname(prefix));

			// Validate the search directory stays within the base directory
			if (!searchDir.startsWith(this.directory + path.sep) && searchDir !== this.directory) {
				throw new EmDashStorageError("Invalid list prefix", "INVALID_PATH");
			}

			const prefixBase = path.basename(prefix);

			// Ensure directory exists
			try {
				await fs.access(searchDir);
			} catch {
				return { files: [] };
			}

			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const files: ListResult["files"] = [];

			for (const entry of entries) {
				if (entry.isFile() && entry.name.startsWith(prefixBase)) {
					const key = path.join(path.dirname(prefix), entry.name);
					const filePath = path.join(searchDir, entry.name);
					const stat = await fs.stat(filePath);

					files.push({
						key,
						size: stat.size,
						lastModified: stat.mtime,
					});
				}
			}

			// Sort by last modified (newest first)
			files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

			// Apply limit and cursor (simple implementation)
			const startIndex = options.cursor ? parseInt(options.cursor, 10) : 0;
			const limit = options.limit || 1000;
			const paginatedFiles = files.slice(startIndex, startIndex + limit);
			const hasMore = startIndex + limit < files.length;

			return {
				files: paginatedFiles,
				nextCursor: hasMore ? String(startIndex + limit) : undefined,
			};
		} catch (error) {
			throw new EmDashStorageError("Failed to list files", "LIST_FAILED", error);
		}
	}

	async getSignedUploadUrl(_options: SignedUploadOptions): Promise<SignedUploadUrl> {
		// Local storage doesn't support signed URLs
		throw new EmDashStorageError(
			"Local storage does not support signed upload URLs. " +
				"Upload files directly through the API.",
			"NOT_SUPPORTED",
		);
	}

	getPublicUrl(key: string): string {
		return `${this.baseUrl}/${key}`;
	}
}

/**
 * Get content type from file extension
 */
function getContentType(ext: string): string {
	return mime.getType(ext) ?? "application/octet-stream";
}

/**
 * Create local storage adapter
 * This is the factory function called at runtime
 */
export function createStorage(config: Record<string, unknown>): Storage {
	const directory = typeof config.directory === "string" ? config.directory : "";
	const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
	return new LocalStorage({ directory, baseUrl });
}
