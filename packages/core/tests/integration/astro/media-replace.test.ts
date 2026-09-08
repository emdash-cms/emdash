import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaGet, handleMediaReplaceMetadata } from "../../../src/api/handlers/media.js";
import { PUT as putReplace } from "../../../src/astro/routes/api/media/[id]/replace.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type User = { id: string; role: 20 | 30 | 40 | 50 };
type ReplaceMetadata = typeof handleMediaReplaceMetadata;

function memoryStorage() {
	const objects = new Map<string, Uint8Array>();
	const upload = vi.fn(
		async (options: {
			key: string;
			body: Uint8Array;
			contentType: string;
			cacheControl?: string;
		}) => {
			objects.set(options.key, options.body);
			return { key: options.key, url: `/media/${options.key}`, size: options.body.byteLength };
		},
	);
	return { objects, upload };
}

function replaceRequest(
	options: {
		bytes?: Uint8Array;
		type?: string;
		width?: string;
		height?: string;
		contentLength?: number;
	} = {},
): Request {
	const form = new FormData();
	form.set(
		"file",
		new File([options.bytes ?? new Uint8Array([9, 8, 7, 6])], "crop.png", {
			type: options.type ?? "image/png",
		}),
	);
	form.set("width", options.width ?? "600");
	form.set("height", options.height ?? "400");
	const headers: Record<string, string> = { "X-EmDash-Request": "1" };
	if (options.contentLength !== undefined)
		headers["Content-Length"] = String(options.contentLength);
	return new Request("http://localhost/_emdash/api/media/media-1/replace", {
		method: "PUT",
		headers,
		body: form,
	});
}

function buildContext(options: {
	db: Kysely<Database>;
	request: Request;
	storage?: ReturnType<typeof memoryStorage>;
	includeStorage?: boolean;
	user?: User | null;
	maxUploadSize?: number;
	replaceMetadata?: ReplaceMetadata;
}): APIContext {
	const user = options.user === undefined ? { id: "author-1", role: 30 as const } : options.user;
	return {
		params: { id: "media-1" },
		url: new URL(options.request.url),
		request: options.request,
		locals: {
			emdash: {
				db: options.db,
				config: { maxUploadSize: options.maxUploadSize },
				...(options.includeStorage === false ? {} : { storage: options.storage }),
				handleMediaGet: (id: string) => handleMediaGet(options.db, id),
				handleMediaReplaceMetadata: (
					options.replaceMetadata ??
					((db, id, key, metadata) => handleMediaReplaceMetadata(db, id, key, metadata))
				).bind(null, options.db),
			},
			user:
				user === null ? undefined : { ...user, email: `${user.id}@example.com`, name: "Test user" },
		},
	} as unknown as APIContext;
}

describe("PUT /media/:id/replace", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function createImage(overrides: Partial<Parameters<MediaRepository["create"]>[0]> = {}) {
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "hero.png",
			mimeType: "image/png",
			size: 120,
			width: 1200,
			height: 800,
			alt: "A mountain",
			caption: "Homepage hero",
			storageKey: "media/hero.png",
			contentHash: "sha256:before",
			blurhash: "before-blurhash",
			dominantColor: "#123456",
			authorId: "author-1",
			...overrides,
		});
		await db.updateTable("media").set({ id: "media-1" }).where("id", "=", item.id).execute();
		return (await repo.findById("media-1"))!;
	}

	it.each([
		{ label: "owner", user: { id: "author-1", role: 30 as const } },
		{ label: "editor", user: { id: "editor-1", role: 40 as const } },
	])("lets the $label replace a ready image without changing its identity", async ({ user }) => {
		const repo = new MediaRepository(db);
		const folder = await new MediaFolderRepository(db).create("Editorial");
		const original = await createImage();
		await repo.update(original.id, { folderId: folder.id, focalX: 0.25, focalY: 0.75 });
		const storage = memoryStorage();
		storage.objects.set(original.storageKey, new Uint8Array([1, 2, 3]));
		const croppedBytes = new Uint8Array([9, 8, 7, 6]);

		const response = await putReplace(
			buildContext({
				db,
				request: replaceRequest({ bytes: croppedBytes, width: "1800", height: "900" }),
				storage,
				user,
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { item: Record<string, unknown> } };
		expect(body.data.item).toMatchObject({
			id: original.id,
			filename: original.filename,
			mimeType: original.mimeType,
			storageKey: original.storageKey,
			url: `/_emdash/api/media/file/${original.storageKey}`,
			size: croppedBytes.byteLength,
			width: 1800,
			height: 900,
			contentHash: await computeContentHash(croppedBytes),
			blurhash: null,
			dominantColor: null,
			focalX: null,
			focalY: null,
			alt: original.alt,
			caption: original.caption,
			authorId: original.authorId,
			folderId: folder.id,
			createdAt: original.createdAt,
		});
		expect(storage.objects.get(original.storageKey)).toEqual(croppedBytes);
		expect(storage.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				cacheControl: "public, max-age=0, must-revalidate",
			}),
		);
		expect((await repo.findMany()).items).toHaveLength(1);
	});

	it.each([
		{ label: "unauthenticated caller", user: null, status: 401 },
		{ label: "contributor", user: { id: "contributor-1", role: 20 as const }, status: 403 },
		{ label: "another author", user: { id: "author-2", role: 30 as const }, status: 403 },
	])("rejects an $label before storage mutation", async ({ user, status }) => {
		await createImage();
		const storage = memoryStorage();

		const response = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, user }),
		);

		expect(response.status).toBe(status);
		expect(storage.upload).not.toHaveBeenCalled();
	});

	it("rejects missing storage and media before mutation", async () => {
		const storage = memoryStorage();
		const missingStorage = await putReplace(
			buildContext({
				db,
				request: replaceRequest(),
				storage,
				includeStorage: false,
			}),
		);
		expect(missingStorage.status).toBe(500);

		const missingMedia = await putReplace(buildContext({ db, request: replaceRequest(), storage }));
		expect(missingMedia.status).toBe(404);
		expect(storage.upload).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "non-ready source",
			source: { status: "pending" as const },
			request: {},
			status: 400,
		},
		{
			label: "unsupported source type",
			source: { mimeType: "image/gif", filename: "hero.gif", storageKey: "hero.gif" },
			request: { type: "image/gif" },
			status: 400,
		},
		{
			label: "mismatched replacement type",
			source: {},
			request: { type: "image/jpeg" },
			status: 400,
		},
		{
			label: "empty file",
			source: {},
			request: { bytes: new Uint8Array() },
			status: 400,
		},
		{
			label: "oversized multipart body before parsing",
			source: {},
			request: { contentLength: 100 },
			maxUploadSize: 50,
			status: 413,
		},
		{
			label: "oversized file",
			source: {},
			request: {},
			maxUploadSize: 3,
			status: 413,
		},
		{
			label: "zero dimension",
			source: {},
			request: { width: "0" },
			status: 400,
		},
		{
			label: "unsafe dimensions",
			source: {},
			request: { width: "9007199254740992" },
			status: 400,
		},
	])("rejects $label before storage mutation", async (testCase) => {
		await createImage(testCase.source);
		const storage = memoryStorage();

		const response = await putReplace(
			buildContext({
				db,
				request: replaceRequest(testCase.request),
				storage,
				maxUploadSize: testCase.maxUploadSize,
			}),
		);

		expect(response.status).toBe(testCase.status);
		expect(storage.upload).not.toHaveBeenCalled();
	});

	it("preserves database metadata when storage replacement fails", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		storage.upload.mockRejectedValueOnce(new Error("storage unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await putReplace(buildContext({ db, request: replaceRequest(), storage }));

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "MEDIA_REPLACE_ERROR" } });
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);
	});

	it("retries metadata after bytes were overwritten without creating another item", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		const replaceMetadata = vi
			.fn<ReplaceMetadata>()
			.mockResolvedValueOnce({
				success: false,
				error: {
					code: "MEDIA_REPLACE_METADATA_ERROR",
					message: "Failed to update replaced media metadata",
				},
			})
			.mockImplementation(handleMediaReplaceMetadata);

		const first = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, replaceMetadata }),
		);
		expect(first.status).toBe(500);
		expect(await first.json()).toMatchObject({
			error: { code: "MEDIA_REPLACE_METADATA_ERROR" },
		});
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);

		const retry = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, replaceMetadata }),
		);
		expect(retry.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledTimes(2);
		expect(storage.upload.mock.calls.map(([options]) => options.key)).toEqual([
			original.storageKey,
			original.storageKey,
		]);
		expect((await new MediaRepository(db).findMany()).items).toHaveLength(1);
	});
});
