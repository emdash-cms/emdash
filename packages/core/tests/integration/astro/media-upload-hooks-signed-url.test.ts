import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	coordinateScopedDbLifecycle,
	finishScoped,
} from "../../../src/astro/middleware/scoped-db.js";
import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { PUT as putUpload } from "../../../src/astro/routes/api/media/[id]/upload.js";
import { POST as postUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { MediaAfterUploadEvent, MediaUploadEvent } from "../../../src/plugins/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { EmDashStorageError } from "../../../src/storage/types.js";
import type { SignedUploadOptions } from "../../../src/storage/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const bytes = new Uint8Array([1, 2, 3]);

function unsupportedSignedUrlStorage() {
	return {
		async getSignedUploadUrl() {
			throw new EmDashStorageError("Signed URLs unavailable", "NOT_SUPPORTED");
		},
	};
}

function streamingStorage() {
	const objects = new Map<string, Uint8Array>();
	const upload = async (options: { key: string; body: ReadableStream<Uint8Array> }) => {
		const value = new Uint8Array(await new Response(options.body).arrayBuffer());
		objects.set(options.key, value);
		return { key: options.key, url: `/media/${options.key}`, size: value.byteLength };
	};
	const deleteObject = async (key: string) => {
		objects.delete(key);
	};
	const exists = async (key: string) => objects.has(key);
	const download = async (key: string) => {
		const value = objects.get(key);
		if (!value) throw new EmDashStorageError("File not found", "NOT_FOUND");
		return {
			body: new Response(value).body as ReadableStream<Uint8Array>,
			contentType: "image/png",
			size: value.byteLength,
		};
	};
	return { objects, upload, delete: deleteObject, exists, download };
}

function buildContext(options: {
	db: Kysely<Database>;
	request: Request;
	storage: unknown;
	hooks: unknown;
	id?: string;
	maxUploadSize?: number;
}): APIContext {
	return {
		params: options.id ? { id: options.id } : {},
		url: new URL(options.request.url),
		request: options.request,
		locals: {
			emdash: {
				db: options.db,
				config: { maxUploadSize: options.maxUploadSize },
				storage: options.storage,
				hooks: options.hooks,
			},
			user: {
				id: "user-1",
				email: "test@example.com",
				name: "Test User",
				role: 30,
			},
		},
	} as unknown as APIContext;
}

function uploadUrlRequest(filename = "photo.png", overrides: Record<string, unknown> = {}) {
	return new Request("http://localhost/_emdash/api/media/upload-url", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({
			filename,
			contentType: "image/png",
			size: bytes.byteLength,
			deduplicate: false,
			...overrides,
		}),
	});
}

function directUploadRequest(id: string) {
	return new Request(`http://localhost/_emdash/api/media/${id}/upload`, {
		method: "PUT",
		headers: {
			"Content-Type": "image/png",
			"Content-Length": String(bytes.byteLength),
			"X-EmDash-Request": "1",
		},
		body: bytes,
	});
}

function confirmRequest(id: string) {
	return new Request(`http://localhost/_emdash/api/media/${id}/confirm`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({ size: bytes.byteLength }),
	});
}

describe("signed-url media upload hooks", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("runs media:beforeUpload and media:afterUpload for the admin upload flow", async () => {
		let beforeUploadEvent: MediaUploadEvent | undefined;
		const afterUploadEvents: MediaAfterUploadEvent[] = [];

		const plugin = definePlugin({
			id: "signed-url-hook-test",
			version: "1.0.0",
			capabilities: ["media:read", "media:write"],
			hooks: {
				"media:beforeUpload": async (event) => {
					beforeUploadEvent = event;
					return {
						...event.file,
						name: `renamed-${event.file.name}`,
					};
				},
				"media:afterUpload": async (event) => {
					afterUploadEvents.push(event);
				},
			},
		});
		const storage = streamingStorage();
		const hooks = createHookPipeline([plugin], { db, storage });

		const uploadUrlResponse = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequest("photo.png"),
				storage: unsupportedSignedUrlStorage(),
				hooks,
			}),
		);

		expect(uploadUrlResponse.status).toBe(200);
		const { mediaId } = (await uploadUrlResponse.json()).data as { mediaId: string };
		expect(await new MediaRepository(db).findById(mediaId)).toMatchObject({
			filename: "renamed-photo.png",
			status: "pending",
		});
		expect(beforeUploadEvent).toMatchObject({
			file: { name: "photo.png", type: "image/png", size: bytes.byteLength },
		});

		const uploadResponse = await putUpload(
			buildContext({
				db,
				id: mediaId,
				request: directUploadRequest(mediaId),
				storage,
				hooks,
			}),
		);
		expect(uploadResponse.status).toBe(200);

		const confirmResponse = await postConfirm(
			buildContext({
				db,
				id: mediaId,
				request: confirmRequest(mediaId),
				storage,
				hooks,
			}),
		);
		expect(confirmResponse.status).toBe(200);

		const confirmed = await new MediaRepository(db).findById(mediaId);
		expect(confirmed).toMatchObject({
			filename: "renamed-photo.png",
			status: "ready",
		});

		await waitForDeferredTasks();
		expect(afterUploadEvents).toHaveLength(1);
		expect(afterUploadEvents[0]?.media).toMatchObject({
			id: mediaId,
			filename: "renamed-photo.png",
			mimeType: "image/png",
			size: bytes.byteLength,
		});

		const repeated = await postConfirm(
			buildContext({ db, id: mediaId, request: confirmRequest(mediaId), storage, hooks }),
		);
		expect(repeated.status).toBe(200);
		await waitForDeferredTasks();
		expect(afterUploadEvents).toHaveLength(1);
	});

	it.each([bytes.byteLength + 1, 6])(
		"uploads the original bytes when a hook returns size %s (limit 5)",
		async (size) => {
			const storage = streamingStorage();
			const hooks = createHookPipeline(
				[
					definePlugin({
						id: "size-metadata",
						version: "1.0.0",
						capabilities: ["media:write"],
						hooks: { "media:beforeUpload": async ({ file }) => ({ ...file, size }) },
					}),
				],
				{ db, storage },
			);
			const response = await postUploadUrl(
				buildContext({
					db,
					hooks,
					storage: unsupportedSignedUrlStorage(),
					request: uploadUrlRequest(),
					maxUploadSize: 5,
				}),
			);
			expect(response.status).toBe(200);
			const { mediaId } = (await response.json()).data;
			const uploaded = await putUpload(
				buildContext({
					db,
					hooks,
					storage,
					id: mediaId,
					request: directUploadRequest(mediaId),
					maxUploadSize: 5,
				}),
			);
			expect(uploaded.status).toBe(200);
			const confirmed = await postConfirm(
				buildContext({ db, hooks, storage, id: mediaId, request: confirmRequest(mediaId) }),
			);
			expect(confirmed.status).toBe(200);
			expect(await new MediaRepository(db).findById(mediaId)).toMatchObject({
				status: "ready",
				size: bytes.byteLength,
			});
		},
	);

	it("signs and confirms the original size while applying hook filename and type", async () => {
		const storage = {
			...streamingStorage(),
			async getSignedUploadUrl(options: SignedUploadOptions) {
				return {
					url: `https://storage.example/${options.key}`,
					method: "PUT" as const,
					headers: { "Content-Length": String(options.size), "Content-Type": options.contentType },
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				};
			},
		};
		const hooks = createHookPipeline(
			[
				definePlugin({
					id: "signed-metadata",
					version: "1.0.0",
					capabilities: ["media:write"],
					hooks: {
						"media:beforeUpload": async ({ file }) => {
							file.size = 6;
							return { ...file, name: "renamed.png", type: "application/octet-stream" };
						},
					},
				}),
			],
			{ db, storage },
		);
		const response = await postUploadUrl(
			buildContext({ db, hooks, storage, maxUploadSize: 5, request: uploadUrlRequest() }),
		);
		expect(response.status).toBe(200);
		const { mediaId, storageKey, uploadUrl, headers } = (await response.json()).data;
		expect(uploadUrl).toBe(`https://storage.example/${storageKey}`);
		expect(storageKey).toMatch(/\.png$/);
		expect(headers).toMatchObject({
			"Content-Length": String(bytes.byteLength),
			"Content-Type": "image/png",
		});
		storage.objects.set(storageKey, bytes);
		const confirmed = await postConfirm(
			buildContext({ db, hooks, storage, id: mediaId, request: confirmRequest(mediaId) }),
		);
		expect(confirmed.status).toBe(200);
		expect(await new MediaRepository(db).findById(mediaId)).toMatchObject({
			filename: "renamed.png",
			mimeType: "image/png",
			size: bytes.byteLength,
			status: "ready",
		});
	});

	it("deduplicates using the submitted size after running beforeUpload", async () => {
		const contentHash = await computeContentHash(bytes);
		const repo = new MediaRepository(db);
		const existing = await repo.create({
			filename: "existing.png",
			mimeType: "image/png",
			size: bytes.byteLength,
			storageKey: "existing.png",
			contentHash,
		});
		let beforeRan = false;
		let afterRan = false;
		const storage = { ...streamingStorage(), getSignedUploadUrl: vi.fn() };
		const hooks = createHookPipeline(
			[
				definePlugin({
					id: "dedup-size",
					version: "1.0.0",
					capabilities: ["media:write", "media:read"],
					hooks: {
						"media:beforeUpload": async ({ file }) => {
							beforeRan = true;
							return { ...file, size: file.size + 1 };
						},
						"media:afterUpload": async () => {
							afterRan = true;
						},
					},
				}),
			],
			{ db, storage },
		);
		const response = await postUploadUrl(
			buildContext({
				db,
				hooks,
				storage,
				request: uploadUrlRequest("photo.png", { contentHash, deduplicate: true }),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { existing: true, mediaId: existing.id } });
		expect(beforeRan).toBe(true);
		await waitForDeferredTasks();
		expect(afterRan).toBe(false);
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
		expect((await repo.findMany({ status: "all" })).items).toHaveLength(1);
	});

	it.each([
		{ name: "" },
		{ name: 123 },
		{ name: undefined },
		{ type: "invalid" },
		{ type: null },
		{ type: "image/png\r\nX-Injected: 1" },
	])("rejects invalid hook metadata %j before allocation", async (metadata) => {
		const storage = { ...streamingStorage(), getSignedUploadUrl: vi.fn() };
		const hooks = createHookPipeline(
			[
				definePlugin({
					id: "invalid-metadata",
					version: "1.0.0",
					capabilities: ["media:write"],
					hooks: {
						"media:beforeUpload": async ({ file }) =>
							({ ...file, ...metadata }) as unknown as MediaUploadEvent["file"],
					},
				}),
			],
			{ db, storage },
		);
		const response = await postUploadUrl(
			buildContext({ db, hooks, storage, request: uploadUrlRequest() }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
		expect((await new MediaRepository(db).findMany({ status: "all" })).items).toHaveLength(0);
	});

	it("rechecks hook MIME types against the upload allowlist", async () => {
		const storage = { ...streamingStorage(), getSignedUploadUrl: vi.fn() };
		const hooks = createHookPipeline(
			[
				definePlugin({
					id: "disallowed-mime",
					version: "1.0.0",
					capabilities: ["media:write"],
					hooks: { "media:beforeUpload": async ({ file }) => ({ ...file, type: "text/html" }) },
				}),
			],
			{ db, storage },
		);
		const response = await postUploadUrl(
			buildContext({ db, hooks, storage, request: uploadUrlRequest() }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_TYPE" } });
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
		expect((await new MediaRepository(db).findMany({ status: "all" })).items).toHaveLength(0);
	});

	it("keeps request resources alive until a delayed afterUpload hook finishes", async () => {
		const storage = streamingStorage();
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: bytes.byteLength,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		storage.objects.set(pending.storageKey, bytes);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let completed = false;
		let closed = false;
		const hooks = createHookPipeline(
			[
				definePlugin({
					id: "delayed-after",
					version: "1.0.0",
					capabilities: ["media:read"],
					hooks: {
						"media:afterUpload": async ({ media }) => {
							await gate;
							if (closed) throw new Error("Request resources already closed");
							expect(await repo.findById(media.id)).toMatchObject({ status: "ready" });
							completed = true;
						},
					},
				}),
			],
			{ db, storage },
		);
		const scope = coordinateScopedDbLifecycle({
			commit() {},
			close() {
				closed = true;
			},
		});
		try {
			const response = await runWithContext(
				{ editMode: false, db, deferredTasks: scope.deferredTasks },
				() =>
					finishScoped(scope.lifecycle, () =>
						Promise.resolve(
							postConfirm(
								buildContext({
									db,
									hooks,
									storage,
									id: pending.id,
									request: confirmRequest(pending.id),
								}),
							),
						),
					),
			);
			expect(response.status).toBe(200);
			await response.json();
			expect(completed).toBe(false);
			expect(closed).toBe(false);
		} finally {
			release();
			await scope.closed;
			await waitForDeferredTasks();
		}
		expect(completed).toBe(true);
		expect(closed).toBe(true);
	});

	it("aborts the admin upload when media:beforeUpload throws", async () => {
		const plugin = definePlugin({
			id: "signed-url-hook-abort-test",
			version: "1.0.0",
			capabilities: ["media:read", "media:write"],
			hooks: {
				"media:beforeUpload": async () => {
					throw new Error("blocked by plugin");
				},
			},
		});
		const storage = streamingStorage();
		const hooks = createHookPipeline([plugin], { db, storage });

		const signingStorage = { getSignedUploadUrl: vi.fn() };
		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequest("photo.png"),
				storage: signingStorage,
				hooks,
			}),
		);

		expect(response.ok).toBe(false);
		expect(signingStorage.getSignedUploadUrl).not.toHaveBeenCalled();
		expect((await new MediaRepository(db).findMany({ status: "all" })).items).toHaveLength(0);
	});
});
