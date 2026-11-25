import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMediaRequests } from "../../utils/media-route-cache.js";

const virtualConfig = vi.hoisted(() => ({}) as { routeCacheProvider?: string });
vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));

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
		delete virtualConfig.routeCacheProvider;
		await rm(directory, { recursive: true, force: true });
	});

	async function upload(key: string, bytes: Uint8Array, contentType: string) {
		await storage.upload({ key, body: bytes, contentType });
	}

	function buildContext(
		key: string,
		request: Request,
		cache?: Pick<APIContext["cache"], "enabled" | "set">,
	): Parameters<typeof GET>[0] {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields read by GET
		return {
			params: { key },
			locals: { emdash: { storage } },
			request,
			cache,
		} as Parameters<typeof GET>[0];
	}

	function routeCache() {
		return { enabled: true, set: vi.fn() };
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

	it("stores a whole image in the route cache under its storage key", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const cache = routeCache();

		const response = await GET(buildContext("image.png", new Request("http://localhost/x"), cache));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(cache.set).toHaveBeenCalledWith({
			maxAge: 31_536_000,
			tags: ["emdash:media:image.png"],
		});
	});

	it("serves but does not cache an image requested with a query", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");

		for (const query of ["?", "?x=1", "?_emdash_media=abc", "?_emdash_media=a&_emdash_media=b"]) {
			const cache = routeCache();
			const response = await GET(
				buildContext("image.png", new Request(`http://localhost/x${query}`), cache),
			);

			expect(response.status).toBe(200);
			expect(cache.set).not.toHaveBeenCalled();
		}
	});

	it("does not cache a 304", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const first = await GET(buildContext("image.png", new Request("http://localhost/x")));
		const cache = routeCache();
		const conditional = new Request("http://localhost/x", {
			headers: { "If-None-Match": first.headers.get("ETag")! },
		});

		const response = await GET(buildContext("image.png", conditional, cache));

		expect(response.status).toBe(304);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("opts a range request out of the route cache", async () => {
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const cache = routeCache();
		const ranged = new Request("http://localhost/x", { headers: { Range: "bytes=0-1" } });

		const response = await GET(buildContext("image.png", ranged, cache));

		expect(response.status).toBe(206);
		expect(cache.set).toHaveBeenCalledWith(false);
		expect(cache.set).toHaveBeenCalledTimes(1);
	});

	it("does not cache video, so a cached file never answers a seek", async () => {
		await upload("clip.mp4", new Uint8Array([1, 2, 3]), "video/mp4");
		const cache = routeCache();

		const response = await GET(buildContext("clip.mp4", new Request("http://localhost/x"), cache));

		expect(response.status).toBe(200);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("does not cache a missing file", async () => {
		const cache = routeCache();

		const response = await GET(
			buildContext("missing.png", new Request("http://localhost/x"), cache),
		);

		expect(response.status).toBe(404);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("does not cache a key whose tag would split at a comma", async () => {
		await upload("photo,1.png", new Uint8Array([1, 2, 3]), "image/jpeg");
		const cache = routeCache();

		const response = await GET(
			buildContext("photo,1.png", new Request("http://localhost/x"), cache),
		);

		expect(response.status).toBe(200);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("caches an image of any size under a CDN provider", async () => {
		virtualConfig.routeCacheProvider = "cloudflare";
		await upload("large.png", new Uint8Array(10 * 1024 * 1024 + 1), "image/png");
		const cache = routeCache();

		await GET(buildContext("large.png", new Request("http://localhost/x"), cache));

		expect(cache.set).toHaveBeenCalledTimes(1);
	});

	it("revalidates an image after the first request with the memory provider", async () => {
		virtualConfig.routeCacheProvider = "memory";
		await upload("image.png", new Uint8Array([1, 2, 3]), "image/png");
		const serve = memoryMediaRequests();
		const url = "http://localhost/_emdash/api/media/file/image.png";
		const request = new Request(url);
		const first = await serve(request, (cache) => GET(buildContext("image.png", request, cache)));
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		const etag = first.headers.get("ETag")!;
		const conditional = new Request(url, { headers: { "If-None-Match": etag } });

		const response = await serve(conditional, (cache) =>
			GET(buildContext("image.png", conditional, cache)),
		);

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.body).toBeNull();
		expect(response.headers.get("X-Astro-Cache")).not.toBe("HIT");
	});
});
