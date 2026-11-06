import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";
import { LocalStorage } from "../../../src/storage/local.js";
import type { Storage } from "../../../src/storage/types.js";

const CLIP = "0123456789";

function serve(
	storage: Pick<Storage, "download">,
	headers: Record<string, string> = {},
	cache?: { enabled: boolean; set: (input: false) => void },
) {
	return GET({
		params: { key: "clip.mp4" },
		locals: { emdash: { storage } },
		request: new Request("https://example.com/_emdash/api/media/file/clip.mp4", { headers }),
		cache,
	} as never);
}

describe("public media file route byte ranges", () => {
	let directory: string;
	let storage: LocalStorage;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "emdash-media-range-"));
		storage = new LocalStorage({ directory, baseUrl: "/_emdash/api/media/file" });
		await storage.upload({
			key: "clip.mp4",
			body: new TextEncoder().encode(CLIP),
			contentType: "video/mp4",
		});
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.each([
		["bytes=2-4", "bytes 2-4/10", "234"],
		["bytes=7-", "bytes 7-9/10", "789"],
		["bytes=-3", "bytes 7-9/10", "789"],
		["bytes=8-100", "bytes 8-9/10", "89"],
		["bytes=0-", "bytes 0-9/10", CLIP],
	])("answers %s with 206 and only those bytes", async (range, contentRange, body) => {
		const response = await serve(storage, { Range: range });

		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe(contentRange);
		expect(response.headers.get("Content-Length")).toBe(String(body.length));
		expect(await response.text()).toBe(body);
	});

	it("keeps the content, cache, and security headers on partial responses", async () => {
		const response = await serve(storage, { Range: "bytes=0-1" });

		expect(Object.fromEntries(response.headers)).toMatchObject({
			"accept-ranges": "bytes",
			"cache-control": "public, max-age=31536000, immutable",
			"content-disposition": "inline",
			"content-security-policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
			"content-type": "video/mp4",
			"x-content-type-options": "nosniff",
		});
	});

	it("keeps range responses out of the route cache", async () => {
		const ranged = { enabled: true, set: vi.fn() };
		const whole = { enabled: true, set: vi.fn() };

		await (await serve(storage, { Range: "bytes=0-1" }, ranged)).body?.cancel();
		await (await serve(storage, {}, whole)).body?.cancel();

		expect(ranged.set).toHaveBeenCalledWith(false);
		expect(whole.set).not.toHaveBeenCalled();
	});

	it("advertises byte ranges on a full response", async () => {
		const response = await serve(storage);

		expect(response.status).toBe(200);
		expect(response.headers.get("Accept-Ranges")).toBe("bytes");
		expect(response.headers.get("Content-Length")).toBe("10");
		expect(await response.text()).toBe(CLIP);
	});

	it.each(["bytes=10-", "bytes=-0"])("answers the unsatisfiable %s with 416", async (range) => {
		const response = await serve(storage, { Range: range });

		expect(response.status).toBe(416);
		expect(response.headers.get("Content-Range")).toBe("bytes */10");
	});

	it.each([
		["several ranges", { Range: "bytes=0-1,4-5" }],
		["a reversed range", { Range: "bytes=5-2" }],
		["another unit", { Range: "items=0-1" }],
		["an If-Range validator", { Range: "bytes=0-1", "If-Range": '"abc"' }],
	])("serves the whole file for %s", async (_label, headers) => {
		const response = await serve(storage, headers);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(CLIP);
	});

	describe("with an adapter that ignores ranges", () => {
		const wholeFile: Pick<Storage, "download"> = {
			download: async () => ({
				body: new Blob([CLIP]).stream(),
				contentType: "video/mp4",
				size: CLIP.length,
			}),
		};

		it("serves the whole file", async () => {
			const response = await serve(wholeFile, { Range: "bytes=2-4" });

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Range")).toBeNull();
			expect(await response.text()).toBe(CLIP);
		});

		it("still rejects a range past the end", async () => {
			const response = await serve(wholeFile, { Range: "bytes=10-" });

			expect(response.status).toBe(416);
			expect(response.headers.get("Content-Range")).toBe("bytes */10");
		});
	});
});
