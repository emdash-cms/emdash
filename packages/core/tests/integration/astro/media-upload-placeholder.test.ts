import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postMedia } from "../../../src/astro/routes/api/media.js";
import type { Database } from "../../../src/database/types.js";
import { JPEG_4x4 } from "../../utils/image-fixtures.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface CapturedInput {
	width?: number;
	height?: number;
	blurhash?: string;
	dominantColor?: string;
}

function buildContext(opts: {
	db: Kysely<Database>;
	file: File;
	captured: { value?: CapturedInput };
	width?: number;
	height?: number;
}): APIContext {
	const formData = new FormData();
	formData.append("file", opts.file);
	if (opts.width != null) formData.append("width", String(opts.width));
	if (opts.height != null) formData.append("height", String(opts.height));
	const request = new Request("http://localhost/_emdash/api/media", {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
		body: formData,
	});
	return {
		params: {},
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db: opts.db,
				config: {},
				storage: {
					async upload(o: { key: string }) {
						return { key: o.key, url: `/m/${o.key}`, size: 0 };
					},
				},
				handleMediaCreate: async (input: CapturedInput & Record<string, unknown>) => {
					opts.captured.value = input;
					return {
						success: true as const,
						data: { item: { id: "t", storageKey: "k", ...input } },
					};
				},
			},
			user: { id: "user-1", email: "t@example.com", name: "T", role: 50 as const },
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("POST /media — server-side placeholder + dimensions", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("derives dimensions and blurhash from the uploaded image when the client sends none", async () => {
		const captured: { value?: CapturedInput } = {};
		const file = new File([JPEG_4x4], "photo.jpg", { type: "image/jpeg" });

		const res = await postMedia(buildContext({ db, file, captured }));

		expect(res.status).toBe(201);
		expect(captured.value?.width).toBe(4);
		expect(captured.value?.height).toBe(4);
		expect(captured.value?.blurhash).toBeTruthy();
		expect(captured.value?.dominantColor).toMatch(/^rgb\(/);
	});

	it("preserves client-sent width/height for non-image uploads and skips placeholder", async () => {
		const captured: { value?: CapturedInput } = {};
		const file = new File([new Uint8Array([1, 2, 3, 4])], "doc.pdf", { type: "application/pdf" });

		const res = await postMedia(buildContext({ db, file, captured, width: 640, height: 480 }));

		expect(res.status).toBe(201);
		expect(captured.value?.width).toBe(640);
		expect(captured.value?.height).toBe(480);
		expect(captured.value?.blurhash).toBeUndefined();
		expect(captured.value?.dominantColor).toBeUndefined();
	});

	it("prefers client-sent width/height over server-derived dims (EXIF orientation safety)", async () => {
		// Browser naturalWidth/Height apply EXIF orientation; image-size reports raw
		// header dims (swapped for 90°/270° JPEGs). REST must honor client dims —
		// matching confirm.ts — not the server header dims.
		const captured: { value?: CapturedInput } = {};
		const file = new File([JPEG_4x4], "photo.jpg", { type: "image/jpeg" });

		const res = await postMedia(buildContext({ db, file, captured, width: 999, height: 999 }));

		expect(res.status).toBe(201);
		// Client dimensions win even though the server read 4×4 from the header.
		expect(captured.value?.width).toBe(999);
		expect(captured.value?.height).toBe(999);
		// A blurhash is still generated from the uploaded bytes.
		expect(captured.value?.blurhash).toBeTruthy();
	});
});
