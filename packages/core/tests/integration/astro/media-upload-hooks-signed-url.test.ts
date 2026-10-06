import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { PUT as putUpload } from "../../../src/astro/routes/api/media/[id]/upload.js";
import { POST as postUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { MediaAfterUploadEvent, MediaUploadEvent } from "../../../src/plugins/types.js";
import { EmDashStorageError } from "../../../src/storage/types.js";
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
}): APIContext {
	return {
		params: options.id ? { id: options.id } : {},
		url: new URL(options.request.url),
		request: options.request,
		locals: {
			emdash: {
				db: options.db,
				config: {},
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

function uploadUrlRequest(filename = "photo.png") {
	return new Request("http://localhost/_emdash/api/media/upload-url", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({
			filename,
			contentType: "image/png",
			size: bytes.byteLength,
			deduplicate: false,
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
		let afterUploadEvent: MediaAfterUploadEvent | undefined;

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
					afterUploadEvent = event;
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

		expect(afterUploadEvent).toBeDefined();
		expect(afterUploadEvent?.media).toMatchObject({
			id: mediaId,
			filename: "renamed-photo.png",
			mimeType: "image/png",
			size: bytes.byteLength,
		});
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

		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequest("photo.png"),
				storage: unsupportedSignedUrlStorage(),
				hooks,
			}),
		);

		expect(response.ok).toBe(false);
		expect((await new MediaRepository(db).findMany({ status: "all" })).items).toHaveLength(0);
	});
});
