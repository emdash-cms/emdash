import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";
import { LocalStorage } from "../../../src/storage/local.js";

describe("GET /_emdash/api/media/file/:key — conditional caching", () => {
	let directory: string;
	let storage: LocalStorage;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "emdash-media-file-route-"));
		storage = new LocalStorage({ directory, baseUrl: "/media" });
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	async function upload(key: string, bytes: Uint8Array, contentType: string) {
		await storage.upload({ key, body: bytes, contentType });
	}

	function buildContext(key: string, request: Request): Parameters<typeof GET>[0] {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields read by GET
		return {
			params: { key },
			locals: { emdash: { storage } },
			request,
		} as Parameters<typeof GET>[0];
	}

	it("serves an image with mutable cache control and weak validators", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const response = await GET(buildContext("image.png", new Request("http://localhost/x")));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9]+-[0-9]+"$/);
		expect(response.headers.get("Last-Modified")).toMatch(/GMT$/);
		expect(response.headers.get("Content-Length")).toBe("3");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("returns 304 when If-None-Match matches the current ETag", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const first = await GET(buildContext("image.png", new Request("http://localhost/x")));
		const etag = first.headers.get("ETag")!;

		const conditional = new Request("http://localhost/x", {
			headers: { "If-None-Match": etag },
		});
		const response = await GET(buildContext("image.png", conditional));

		expect(response.status).toBe(304);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.headers.get("Last-Modified")).toBe(first.headers.get("Last-Modified"));
		expect(response.body).toBeNull();
	});

	it("returns 304 when If-Modified-Since is not older than the file", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const first = await GET(buildContext("image.png", new Request("http://localhost/x")));
		const lastModified = first.headers.get("Last-Modified")!;

		const conditional = new Request("http://localhost/x", {
			headers: { "If-Modified-Since": lastModified },
		});
		const response = await GET(buildContext("image.png", conditional));

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(first.headers.get("ETag"));
	});

	it("returns 200 with a new ETag after the same-key bytes change", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const first = await GET(buildContext("image.png", new Request("http://localhost/x")));
		const etag = first.headers.get("ETag")!;

		await upload("image.png", new Uint8Array([4, 5, 6, 7]), "image/png");
		const conditional = new Request("http://localhost/x", {
			headers: { "If-None-Match": etag },
		});
		const response = await GET(buildContext("image.png", conditional));

		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).not.toBe(etag);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7]));
	});

	it("serves non-image content with immutable cache control and validators", async () => {
		await upload("document.pdf", new Uint8Array([8, 9]), "application/pdf");
		const response = await GET(buildContext("document.pdf", new Request("http://localhost/x")));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9]+-[0-9]+"$/);
		expect(response.headers.get("Content-Disposition")).toBe("attachment");
	});
});
