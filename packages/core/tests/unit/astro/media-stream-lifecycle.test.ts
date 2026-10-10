import { Agent, createServer, get } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("astro:assets", () => ({
	imageConfig: {},
	getConfiguredImageService: async () => ({
		parseURL: (url: URL) => {
			if (url.searchParams.has("fail")) throw new Error("Invalid transform");
			return url.searchParams.has("w") ? { width: 400 } : null;
		},
		transform: async (data: Uint8Array) => ({ data, format: "png" }),
	}),
}));

vi.mock("astro/assets/endpoint/generic", () => ({
	GET: async () => new Response("generic", { status: 418 }),
}));

import { GET as imageGET } from "../../../src/astro/image-endpoint.js";
import { GET as mediaGET } from "../../../src/astro/routes/api/media/file/[...key].js";
import type { DownloadResult, Storage } from "../../../src/storage/types.js";

const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
const lastModified = new Date("2026-01-15T12:00:00.000Z");

async function withStorage(run: (storage: Pick<Storage, "download">) => Promise<void>) {
	const server = createServer((request, response) => {
		response.writeHead(200, {
			"Content-Type": request.url?.includes("document") ? "application/pdf" : "image/png",
			"Content-Length": bytes.length,
		});
		response.end(bytes);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	const endpoint = `http://127.0.0.1:${address.port}`;
	const agent = new Agent({ keepAlive: true, maxSockets: 2 });
	const storage: Pick<Storage, "download"> = {
		download: (key) =>
			new Promise<DownloadResult>((resolve, reject) => {
				const request = get(
					`${endpoint}/${key}`,
					{ agent, signal: AbortSignal.timeout(2_000) },
					(response) => {
						// Backpressure keeps unread source bytes on the HTTP connection.
						const body = Readable.toWeb(response, {
							strategy: { highWaterMark: 0 },
						}) as ReadableStream<Uint8Array>;
						resolve({
							body,
							contentType: response.headers["content-type"] ?? "application/octet-stream",
							size: bytes.length,
							lastModified,
						});
					},
				);
				request.on("error", reject);
			}),
	};
	try {
		await run(storage);
	} finally {
		agent.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}
}

function context(
	storage: Pick<Storage, "download">,
	url: string,
	options: RequestInit = {},
): Parameters<typeof mediaGET>[0] {
	return {
		request: new Request(url, options),
		params: { key: "image.png" },
		locals: { emdash: { storage } },
	} as Parameters<typeof mediaGET>[0];
}

describe("media routes with a bounded storage connection pool", () => {
	it.each([
		[
			"original conditional GET",
			mediaGET,
			"http://localhost/_emdash/api/media/file/image.png",
			"GET",
		],
		[
			"thumbnail conditional GET",
			imageGET,
			"http://localhost/_image?href=/_emdash/api/media/file/image.png&w=400",
			"GET",
		],
		[
			"image fallback conditional GET",
			imageGET,
			"http://localhost/_image?href=/_emdash/api/media/file/image.png",
			"GET",
		],
		[
			"non-image conditional GET",
			imageGET,
			"http://localhost/_image?href=/_emdash/api/media/file/document.pdf",
			"GET",
		],
		["original HEAD", mediaGET, "http://localhost/_emdash/api/media/file/image.png", "HEAD"],
		[
			"image fallback HEAD",
			imageGET,
			"http://localhost/_image?href=/_emdash/api/media/file/image.png",
			"HEAD",
		],
		[
			"non-image HEAD",
			imageGET,
			"http://localhost/_image?href=/_emdash/api/media/file/document.pdf",
			"HEAD",
		],
	] as const)(
		"%s leaves connections available for subsequent downloads",
		async (_label, handler, url, method) => {
			await withStorage(async (storage) => {
				const first = await handler(context(storage, url));
				expect(first.status).toBe(200);
				await first.arrayBuffer();
				for (let index = 0; index < 8; index++) {
					const headers =
						index % 2
							? { "If-Modified-Since": lastModified.toUTCString() }
							: { "If-None-Match": first.headers.get("ETag")! };
					const response = await handler(
						context(storage, url, {
							method,
							headers: method === "GET" ? headers : {},
						}),
					);
					expect(response.status).toBe(method === "GET" ? 304 : 200);
					expect(response.body).toBeNull();
				}
				const final = await handler(context(storage, url));
				expect(final.status).toBe(200);
				expect((await final.arrayBuffer()).byteLength).toBe(bytes.length);
			});
		},
	);

	it("releases source connections when parsing transform options throws", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await withStorage(async (storage) => {
				for (let index = 0; index < 8; index++) {
					const response = await imageGET(
						context(
							storage,
							"http://localhost/_image?href=/_emdash/api/media/file/image.png&fail=1",
						),
					);
					expect(response.status).toBe(500);
				}
				const response = await mediaGET(
					context(storage, "http://localhost/_emdash/api/media/file/image.png"),
				);
				expect(response.status).toBe(200);
				expect((await response.arrayBuffer()).byteLength).toBe(bytes.length);
			});
		} finally {
			log.mockRestore();
		}
	});
});
