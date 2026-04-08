/**
 * MarketplaceClient + tar parser tests
 *
 * Tests:
 * - createMarketplaceClient factory
 * - MarketplaceClient.search/getPlugin/getVersions
 * - Bundle download and extraction (tar + gzip)
 * - Error handling (unavailable, HTTP errors)
 * - reportInstall (fire-and-forget)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	createMarketplaceClient,
	MarketplaceError,
	MarketplaceUnavailableError,
	type MarketplaceClient,
	type MarketplacePluginDetail,
	type MarketplaceSearchResult,
} from "../../../src/plugins/marketplace.js";

const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const HEX_16_PATTERN = /^[a-f0-9]{16}$/;

// ── Helpers ───────────���────────────────────────────────────────────

/**
 * Create a minimal tar archive from a map of filename → content.
 * Returns an uncompressed tar buffer.
 */
function createTar(files: Record<string, string>): Uint8Array {
	const blocks: Uint8Array[] = [];
	const encoder = new TextEncoder();

	for (const [name, content] of Object.entries(files)) {
		const contentBytes = encoder.encode(content);
		const size = contentBytes.length;

		// Create 512-byte header
		const header = new Uint8Array(512);
		// Name (bytes 0-99)
		const nameBytes = encoder.encode(name);
		header.set(nameBytes.subarray(0, 100), 0);

		// File mode (bytes 100-107): "0000644\0"
		header.set(encoder.encode("0000644\0"), 100);

		// UID (bytes 108-115): "0000000\0"
		header.set(encoder.encode("0000000\0"), 108);

		// GID (bytes 116-123): "0000000\0"
		header.set(encoder.encode("0000000\0"), 116);

		// Size in octal (bytes 124-135)
		const sizeOctal = size.toString(8).padStart(11, "0") + "\0";
		header.set(encoder.encode(sizeOctal), 124);

		// Mtime (bytes 136-147): "00000000000\0"
		header.set(encoder.encode("00000000000\0"), 136);

		// Type flag (byte 156): '0' for regular file
		header[156] = 0x30;

		// Checksum (bytes 148-155): compute after setting spaces
		// Initially fill with spaces
		header.set(encoder.encode("        "), 148);

		// Compute checksum (sum of all unsigned bytes in header)
		let checksum = 0;
		for (let i = 0; i < 512; i++) {
			checksum += header[i]!;
		}
		const checksumOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
		header.set(encoder.encode(checksumOctal), 148);

		blocks.push(header);

		// File data (padded to 512-byte boundary)
		const paddedSize = Math.ceil(size / 512) * 512;
		const dataBlock = new Uint8Array(paddedSize);
		dataBlock.set(contentBytes, 0);
		blocks.push(dataBlock);
	}

	// Two 512-byte zero blocks = end of archive
	blocks.push(new Uint8Array(1024));

	// Concatenate all blocks
	const totalSize = blocks.reduce((sum, b) => sum + b.length, 0);
	const tar = new Uint8Array(totalSize);
	let offset = 0;
	for (const block of blocks) {
		tar.set(block, offset);
		offset += block.length;
	}

	return tar;
}

/**
 * Gzip compress data using CompressionStream
 */
async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	const writer = cs.writable.getWriter();
	const reader = cs.readable.getReader();

	const writePromise = writer.write(data).then(() => writer.close());
	const chunks: Uint8Array[] = [];
	let totalLength = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		totalLength += value.length;
	}
	await writePromise;

	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

const BASE_URL = "https://marketplace.example.com";

function mockPlugin(): MarketplacePluginDetail {
	return {
		id: "test-seo",
		name: "Test SEO",
		description: "SEO plugin",
		author: { name: "Test Author", verified: true, avatarUrl: null },
		capabilities: ["hooks"],
		keywords: ["seo"],
		installCount: 42,
		hasIcon: false,
		iconUrl: `${BASE_URL}/api/v1/plugins/test-seo/icon`,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-02-01T00:00:00Z",
		repositoryUrl: "https://github.com/test/test-seo",
		homepageUrl: null,
		license: "MIT",
		latestVersion: {
			version: "1.0.0",
			minEmDashVersion: null,
			bundleSize: 1234,
			checksum: "abc123",
			changelog: "Initial release",
			readme: "# Test SEO",
			hasIcon: false,
			screenshotCount: 0,
			screenshotUrls: [],
			capabilities: ["hooks"],
			auditVerdict: "pass",
			imageAuditVerdict: "pass",
			publishedAt: "2026-01-01T00:00:00Z",
		},
	};
}

describe("MarketplaceClient", () => {
	let client: MarketplaceClient;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		client = createMarketplaceClient(BASE_URL);
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("search", () => {
		it("fetches plugins from marketplace", async () => {
			const searchResult: MarketplaceSearchResult = {
				items: [
					{
						id: "test-seo",
						name: "Test SEO",
						description: "SEO plugin",
						author: { name: "Test", verified: true, avatarUrl: null },
						capabilities: ["hooks"],
						keywords: ["seo"],
						installCount: 10,
						hasIcon: false,
						iconUrl: `${BASE_URL}/api/v1/plugins/test-seo/icon`,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-02-01T00:00:00Z",
					},
				],
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(searchResult), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.search("seo");
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.id).toBe("test-seo");

			expect(fetchSpy).toHaveBeenCalledWith(
				`${BASE_URL}/api/v1/plugins?q=seo`,
				expect.objectContaining({ headers: { Accept: "application/json" } }),
			);
		});

		it("passes category and limit as query params", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

			await client.search(undefined, { category: "analytics", limit: 10 });

			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toContain("category=analytics");
			expect(url).toContain("limit=10");
		});

		it("throws MarketplaceUnavailableError on network failure", async () => {
			fetchSpy.mockRejectedValueOnce(new Error("Network error"));

			await expect(client.search("test")).rejects.toThrow(MarketplaceUnavailableError);
		});

		it("throws MarketplaceError on HTTP error", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 }),
			);

			await expect(client.search("test")).rejects.toThrow(MarketplaceError);
		});
	});

	describe("getPlugin", () => {
		it("fetches plugin detail", async () => {
			const plugin = mockPlugin();
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(plugin), { status: 200 }));

			const result = await client.getPlugin("test-seo");
			expect(result.id).toBe("test-seo");
			expect(result.latestVersion?.version).toBe("1.0.0");
		});

		it("encodes plugin ID in URL", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockPlugin()), { status: 200 }));

			await client.getPlugin("@scope/plugin");

			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toContain("%40scope%2Fplugin");
		});
	});

	describe("getVersions", () => {
		it("fetches version list", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								version: "1.0.0",
								minEmDashVersion: null,
								bundleSize: 1234,
								checksum: "abc",
								changelog: "First",
								capabilities: ["hooks"],
								auditVerdict: "pass",
								imageAuditVerdict: "pass",
								publishedAt: "2026-01-01T00:00:00Z",
							},
						],
					}),
					{ status: 200 },
				),
			);

			const versions = await client.getVersions("test-seo");
			expect(versions).toHaveLength(1);
			expect(versions[0]!.version).toBe("1.0.0");
		});
	});

	describe("downloadBundle", () => {
		it("downloads, decompresses, and extracts a bundle tarball", async () => {
			const manifest = {
				id: "test-seo",
				version: "1.0.0",
				capabilities: ["read:content"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			};

			const tarData = createTar({
				"manifest.json": JSON.stringify(manifest),
				"backend.js": 'export default function() { return "hello"; }',
			});
			const gzipped = await gzip(tarData);

			fetchSpy.mockResolvedValueOnce(
				new Response(gzipped, {
					status: 200,
					headers: { "Content-Type": "application/gzip" },
				}),
			);

			const bundle = await client.downloadBundle("test-seo", "1.0.0");

			expect(bundle.manifest.id).toBe("test-seo");
			expect(bundle.manifest.version).toBe("1.0.0");
			expect(bundle.backendCode).toContain("hello");
			expect(bundle.checksum).toMatch(HEX_64_PATTERN);
		});

		it("extracts optional admin.js", async () => {
			const manifest = {
				id: "test-seo",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			};

			const tarData = createTar({
				"manifest.json": JSON.stringify(manifest),
				"backend.js": "export default {};",
				"admin.js": "export const Admin = {};",
			});
			const gzipped = await gzip(tarData);

			fetchSpy.mockResolvedValueOnce(new Response(gzipped, { status: 200 }));

			const bundle = await client.downloadBundle("test-seo", "1.0.0");
			expect(bundle.adminCode).toContain("Admin");
		});

		it("throws on missing manifest.json", async () => {
			const tarData = createTar({
				"backend.js": "export default {};",
			});
			const gzipped = await gzip(tarData);

			fetchSpy.mockResolvedValueOnce(new Response(gzipped, { status: 200 }));

			await expect(client.downloadBundle("test-seo", "1.0.0")).rejects.toThrow(
				"missing manifest.json",
			);
		});

		it("throws on missing backend.js", async () => {
			const tarData = createTar({
				"manifest.json": JSON.stringify({
					id: "test",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [],
					admin: {},
				}),
			});
			const gzipped = await gzip(tarData);

			fetchSpy.mockResolvedValueOnce(new Response(gzipped, { status: 200 }));

			await expect(client.downloadBundle("test-seo", "1.0.0")).rejects.toThrow(
				"missing backend.js",
			);
		});

		it("throws on malformed manifest.json", async () => {
			const tarData = createTar({
				"manifest.json": "not-json{{{",
				"backend.js": "export default {};",
			});
			const gzipped = await gzip(tarData);

			fetchSpy.mockResolvedValueOnce(new Response(gzipped, { status: 200 }));

			await expect(client.downloadBundle("test-seo", "1.0.0")).rejects.toThrow(
				"malformed manifest.json",
			);
		});

		it("throws MarketplaceUnavailableError on network failure", async () => {
			fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

			await expect(client.downloadBundle("test-seo", "1.0.0")).rejects.toThrow(
				MarketplaceUnavailableError,
			);
		});

		it("throws on HTTP error from bundle download", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

			await expect(client.downloadBundle("test-seo", "1.0.0")).rejects.toThrow(MarketplaceError);
		});
	});

	describe("reportInstall", () => {
		it("sends install stat without throwing", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("OK", { status: 200 }));

			// Should not throw even if we await it
			await client.reportInstall("test-seo", "1.0.0");

			expect(fetchSpy).toHaveBeenCalledWith(
				`${BASE_URL}/api/v1/plugins/test-seo/installs`,
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		it("does not throw on network failure", async () => {
			fetchSpy.mockRejectedValueOnce(new Error("Network error"));

			// Should not throw
			await client.reportInstall("test-seo", "1.0.0");
		});

		it("sends a stable site hash across multiple calls", async () => {
			const clientWithOrigin = createMarketplaceClient(BASE_URL, "https://myblog.example.com");

			fetchSpy.mockResolvedValue(new Response("OK", { status: 200 }));

			await clientWithOrigin.reportInstall("test-seo", "1.0.0");
			await clientWithOrigin.reportInstall("test-seo", "1.0.0");

			const calls = fetchSpy.mock.calls;
			expect(calls.length).toBe(2);

			const body1 = JSON.parse(calls[0]![1]!.body as string);
			const body2 = JSON.parse(calls[1]![1]!.body as string);

			// Same origin produces the same hash every time
			expect(body1.siteHash).toBe(body2.siteHash);
			expect(body1.siteHash).toMatch(HEX_16_PATTERN);
		});

		it("produces different hashes for different site origins", async () => {
			const client1 = createMarketplaceClient(BASE_URL, "https://site-a.example.com");
			const client2 = createMarketplaceClient(BASE_URL, "https://site-b.example.com");

			fetchSpy.mockResolvedValue(new Response("OK", { status: 200 }));

			await client1.reportInstall("test-seo", "1.0.0");
			await client2.reportInstall("test-seo", "1.0.0");

			const body1 = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
			const body2 = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);

			expect(body1.siteHash).not.toBe(body2.siteHash);
		});
	});

	describe("trailing slash handling", () => {
		it("strips trailing slashes from base URL", async () => {
			const clientWithSlash = createMarketplaceClient("https://example.com/");
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

			await clientWithSlash.search("test");

			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toContain("https://example.com/api/v1/plugins");
			expect(url).not.toContain("//api");
		});
	});
});

describe("tar parser", () => {
	it("handles files with ./ prefix in paths", async () => {
		// Create tar with ./ prefixed paths (common from tar tools)
		const manifest = {
			id: "test",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [],
			admin: {},
		};
		const files: Record<string, string> = {};
		files["./manifest.json"] = JSON.stringify(manifest);
		files["./backend.js"] = "export default {};";

		const tarData = createTar(files);
		const gzipped = await gzip(tarData);

		const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(gzipped, { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		const client = createMarketplaceClient("https://example.com");
		const bundle = await client.downloadBundle("test", "1.0.0");

		expect(bundle.manifest.id).toBe("test");
		vi.restoreAllMocks();
	});

	it("handles empty tar archive gracefully", async () => {
		// Just two zero blocks (empty archive)
		const emptyTar = new Uint8Array(1024);
		const gzipped = await gzip(emptyTar);

		const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(gzipped, { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		const client = createMarketplaceClient("https://example.com");
		await expect(client.downloadBundle("test", "1.0.0")).rejects.toThrow("missing manifest.json");
		vi.restoreAllMocks();
	});
});
