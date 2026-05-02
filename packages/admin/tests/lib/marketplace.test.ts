import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	searchMarketplace,
	fetchMarketplacePlugin,
	installMarketplacePlugin,
	updateMarketplacePlugin,
	uninstallMarketplacePlugin,
	checkPluginUpdates,
	describeCapability,
	CAPABILITY_LABELS,
} from "../../src/lib/api/marketplace";

describe("marketplace API client", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// -----------------------------------------------------------------------
	// searchMarketplace
	// -----------------------------------------------------------------------

	describe("searchMarketplace", () => {
		it("calls correct URL with no params", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { items: [], nextCursor: undefined } }), {
					status: 200,
				}),
			);
			await searchMarketplace();
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/marketplace");
		});

		it("appends query params when provided", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
			);
			await searchMarketplace({ q: "seo", sort: "installs", limit: 10, cursor: "abc" });
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toContain("q=seo");
			expect(url).toContain("sort=installs");
			expect(url).toContain("limit=10");
			expect(url).toContain("cursor=abc");
		});

		it("omits undefined params", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
			);
			await searchMarketplace({ q: "test" });
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toContain("q=test");
			expect(url).not.toContain("sort=");
			expect(url).not.toContain("cursor=");
			expect(url).not.toContain("limit=");
		});

		it("includes CSRF header", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
			);
			await searchMarketplace();
			const [, init] = fetchSpy.mock.calls[0]!;
			const headers = new Headers(init.headers);
			expect(headers.get("X-EmDash-Request")).toBe("1");
		});

		it("throws on non-ok response", async () => {
			fetchSpy.mockResolvedValue(
				new Response("", { status: 503, statusText: "Service Unavailable" }),
			);
			await expect(searchMarketplace()).rejects.toThrow("Marketplace search failed");
		});
	});

	// -----------------------------------------------------------------------
	// fetchMarketplacePlugin
	// -----------------------------------------------------------------------

	describe("fetchMarketplacePlugin", () => {
		it("calls correct URL with encoded ID", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { id: "my-plugin", name: "My Plugin" } }), {
					status: 200,
				}),
			);
			await fetchMarketplacePlugin("my-plugin");
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/marketplace/my-plugin");
		});

		it("encodes special characters in ID", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { id: "a/b" } }), { status: 200 }),
			);
			await fetchMarketplacePlugin("a/b");
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/marketplace/a%2Fb");
		});

		it("throws specific message on 404", async () => {
			fetchSpy.mockResolvedValue(new Response("", { status: 404 }));
			await expect(fetchMarketplacePlugin("nonexistent")).rejects.toThrow(
				'Plugin "nonexistent" not found in marketplace',
			);
		});

		it("throws generic message on other errors", async () => {
			fetchSpy.mockResolvedValue(
				new Response("", { status: 500, statusText: "Internal Server Error" }),
			);
			await expect(fetchMarketplacePlugin("broken")).rejects.toThrow("Failed to fetch plugin");
		});
	});

	// -----------------------------------------------------------------------
	// installMarketplacePlugin
	// -----------------------------------------------------------------------

	describe("installMarketplacePlugin", () => {
		it("POSTs to correct URL", async () => {
			fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
			await installMarketplacePlugin("my-plugin", { version: "1.0.0" });
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/marketplace/my-plugin/install");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body)).toEqual({ version: "1.0.0" });
		});

		it("throws error message from response body", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: "Version conflict" } }), { status: 409 }),
			);
			await expect(installMarketplacePlugin("my-plugin")).rejects.toThrow("Version conflict");
		});

		it("falls back to statusText when body has no message", async () => {
			fetchSpy.mockResolvedValue(
				new Response("not json", { status: 500, statusText: "Server Error" }),
			);
			await expect(installMarketplacePlugin("my-plugin")).rejects.toThrow(
				"Failed to install plugin: Server Error",
			);
		});
	});

	// -----------------------------------------------------------------------
	// updateMarketplacePlugin
	// -----------------------------------------------------------------------

	describe("updateMarketplacePlugin", () => {
		it("POSTs to plugin update endpoint (not marketplace proxy)", async () => {
			fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
			await updateMarketplacePlugin("my-plugin", { confirmCapabilities: true });
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/my-plugin/update");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body)).toEqual({ confirmCapabilities: true });
		});

		it("throws error message from response body", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: "Capability mismatch" } }), {
					status: 400,
				}),
			);
			await expect(updateMarketplacePlugin("x")).rejects.toThrow("Capability mismatch");
		});
	});

	// -----------------------------------------------------------------------
	// uninstallMarketplacePlugin
	// -----------------------------------------------------------------------

	describe("uninstallMarketplacePlugin", () => {
		it("POSTs to the uninstall endpoint", async () => {
			fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
			await uninstallMarketplacePlugin("my-plugin", { deleteData: true });
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/my-plugin/uninstall");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body)).toEqual({ deleteData: true });
		});

		it("defaults to empty opts", async () => {
			fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
			await uninstallMarketplacePlugin("my-plugin");
			const [, init] = fetchSpy.mock.calls[0]!;
			expect(JSON.parse(init.body)).toEqual({});
		});
	});

	// -----------------------------------------------------------------------
	// checkPluginUpdates
	// -----------------------------------------------------------------------

	describe("checkPluginUpdates", () => {
		it("GETs the updates endpoint and returns items", async () => {
			const updates = [
				{ pluginId: "a", installed: "1.0.0", latest: "2.0.0", hasCapabilityChanges: true },
			];
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ data: { items: updates } }), { status: 200 }),
			);
			const result = await checkPluginUpdates();
			expect(result).toEqual(updates);
			const [url] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("/_emdash/api/admin/plugins/updates");
		});

		it("throws on non-ok response", async () => {
			fetchSpy.mockResolvedValue(new Response("", { status: 500, statusText: "Server Error" }));
			await expect(checkPluginUpdates()).rejects.toThrow("Failed to check for updates");
		});
	});
});

// ---------------------------------------------------------------------------
// describeCapability helper
// ---------------------------------------------------------------------------

describe("describeCapability", () => {
	it("returns known capability label", () => {
		expect(describeCapability("read:content")).toBe("Read your content");
		expect(describeCapability("write:media")).toBe("Upload and manage media");
	});

	it("returns raw capability string for unknown capabilities", () => {
		expect(describeCapability("custom:something")).toBe("custom:something");
	});

	it("appends allowed hosts for network:fetch", () => {
		const result = describeCapability("network:fetch", ["api.example.com", "cdn.example.com"]);
		expect(result).toBe("Make network requests to: api.example.com, cdn.example.com");
	});

	it("ignores empty allowed hosts for network:fetch", () => {
		expect(describeCapability("network:fetch", [])).toBe("Make network requests");
		expect(describeCapability("network:fetch")).toBe("Make network requests");
	});

	it("ignores allowed hosts for non-fetch capabilities", () => {
		expect(describeCapability("read:content", ["example.com"])).toBe("Read your content");
	});
});

describe("CAPABILITY_LABELS", () => {
	it("has entries for all known capabilities", () => {
		expect(Object.keys(CAPABILITY_LABELS)).toEqual([
			// Canonical
			"content:read",
			"content:write",
			"media:read",
			"media:write",
			"users:read",
			"network:request",
			"network:request:unrestricted",
			// Legacy aliases
			"read:content",
			"write:content",
			"read:media",
			"write:media",
			"read:users",
			"network:fetch",
			"network:fetch:any",
		]);
	});
});
