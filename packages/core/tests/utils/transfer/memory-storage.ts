import type { DownloadResult, ListOptions, Storage } from "../../../src/storage/types.js";

export interface StoredObject {
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
}

export interface MemoryStorage extends Storage {
	readonly files: Map<string, StoredObject>;
	/** Called before each upload is stored; throw to simulate a storage failure. */
	beforeUpload?: (key: string) => void;
}

async function collect(
	body: Uint8Array | ReadableStream<Uint8Array> | Buffer,
): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return new Uint8Array(body);
	return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * In-memory `Storage` for transfer tests. Accepts streamed uploads, lists by
 * prefix in key order with a `limit`, and lets a test inject upload failures
 * through `beforeUpload`.
 */
export function createMemoryStorage(): MemoryStorage {
	const files = new Map<string, StoredObject>();
	const storage: MemoryStorage = {
		files,
		async upload(options) {
			const body = await collect(options.body);
			storage.beforeUpload?.(options.key);
			files.set(options.key, {
				body,
				contentType: options.contentType,
				lastModified: new Date(),
			});
			return { key: options.key, url: `memory://${options.key}`, size: body.byteLength };
		},
		async download(key): Promise<DownloadResult> {
			const file = files.get(key);
			if (!file) throw new Error(`not found: ${key}`);
			return {
				body: new Blob([file.body]).stream(),
				contentType: file.contentType,
				size: file.body.byteLength,
			};
		},
		async delete(key) {
			files.delete(key);
		},
		async exists(key) {
			return files.has(key);
		},
		async list(options?: ListOptions) {
			const prefix = options?.prefix ?? "";
			const keys = [...files.keys()].filter((key) => key.startsWith(prefix)).toSorted();
			const start = options?.cursor ? keys.findIndex((key) => key > options.cursor!) : 0;
			const from = start === -1 ? keys.length : start;
			const limit = options?.limit ?? keys.length;
			const page = keys.slice(from, from + limit);
			const next = from + limit < keys.length ? page.at(-1) : undefined;
			return {
				files: page.map((key) => ({
					key,
					size: files.get(key)!.body.byteLength,
					lastModified: files.get(key)!.lastModified,
				})),
				...(next ? { nextCursor: next } : {}),
			};
		},
		async getSignedUploadUrl() {
			throw new Error("not implemented");
		},
		getPublicUrl(key) {
			return `memory://${key}`;
		},
	};
	return storage;
}
