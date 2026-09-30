import { describe, expect, it, vi } from "vitest";

import {
	createSiteSearchTool,
	registerSiteSearchTool,
	resolveModelContext,
	type ModelContextLike,
	type SiteSearchToolConfig,
} from "../../../src/components/webmcp-search.js";

const config: SiteSearchToolConfig = {
	collections: "posts,pages",
	locale: "fr",
	limit: 5,
	routeMap: { posts: "/blog/:slug" },
};

function stubFetch(items: unknown[], status = 200) {
	return vi.fn<typeof fetch>(async () => Response.json({ data: { items } }, { status }));
}

function requestedUrl(fetchImpl: ReturnType<typeof stubFetch>): URL {
	const input = fetchImpl.mock.calls[0]?.[0];
	return new URL(input instanceof Request ? input.url : String(input));
}

describe("WebMCP site search tool", () => {
	it("searches the public API with the configured scope and clamps the limit", async () => {
		const fetchImpl = stubFetch([]);
		const tool = createSiteSearchTool(config, "https://example.com", fetchImpl);

		await tool.execute({ query: "  cheese ", limit: 50 });

		const url = requestedUrl(fetchImpl);
		expect(url.origin + url.pathname).toBe("https://example.com/_emdash/api/search");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: "cheese",
			limit: "5",
			collections: "posts,pages",
			locale: "fr",
		});
	});

	it("returns absolute URLs and plain-text excerpts", async () => {
		const fetchImpl = stubFetch([
			{
				collection: "posts",
				id: "01A",
				slug: "brie",
				title: "Brie",
				snippet: "Soft <mark>cheese</mark> &amp; &lt;b&gt;bread&lt;/b&gt;",
			},
			{ collection: "pages", id: "01B", slug: "about" },
		]);
		const tool = createSiteSearchTool(config, "https://example.com", fetchImpl);

		const result = await tool.execute({ query: "cheese" });

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]!.text)).toEqual([
			{
				title: "Brie",
				url: "https://example.com/blog/brie",
				collection: "posts",
				excerpt: "Soft cheese & <b>bread</b>",
			},
			{ title: "about", url: "https://example.com/pages/about", collection: "pages" },
		]);
	});

	it("reports an empty query or failed request as a tool error without throwing", async () => {
		const fetchImpl = stubFetch([], 500);
		const tool = createSiteSearchTool(config, "https://example.com", fetchImpl);

		expect((await tool.execute({ query: " " })).isError).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await tool.execute({ query: "cheese" })).isError).toBe(true);

		const offline = createSiteSearchTool(config, "https://example.com", async () => {
			throw new TypeError("Failed to fetch");
		});
		expect((await offline.execute({ query: "cheese" })).isError).toBe(true);
	});

	it("keeps the configured limit within what the search API accepts", async () => {
		const fetchImpl = stubFetch([]);
		const tool = createSiteSearchTool({ ...config, limit: 500 }, "https://example.com", fetchImpl);

		await tool.execute({ query: "cheese" });

		expect(requestedUrl(fetchImpl).searchParams.get("limit")).toBe("100");
	});

	it("prefers document.modelContext over the deprecated navigator location", () => {
		const onDocument: ModelContextLike = { registerTool: vi.fn() };
		const onNavigator: ModelContextLike = { registerTool: vi.fn() };

		expect(resolveModelContext({ modelContext: onDocument }, { modelContext: onNavigator })).toBe(
			onDocument,
		);
		expect(resolveModelContext({}, { modelContext: onNavigator })).toBe(onNavigator);
		expect(resolveModelContext({}, {})).toBeUndefined();
	});

	it("unregisters the tool when the signal aborts", () => {
		const tools = new Map<string, unknown>();
		const modelContext: ModelContextLike = {
			registerTool: (tool, options) => {
				tools.set(tool.name, tool);
				options?.signal?.addEventListener("abort", () => tools.delete(tool.name));
			},
		};
		const controller = new AbortController();

		expect(registerSiteSearchTool(undefined, config, "https://example.com")).toBe(false);
		expect(
			registerSiteSearchTool(modelContext, config, "https://example.com", controller.signal),
		).toBe(true);
		expect(tools.has("search_site")).toBe(true);

		controller.abort();
		expect(tools.has("search_site")).toBe(false);
	});

	it("does not throw when the browser rejects the registration", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registerTool = vi.fn(() => {
			throw new DOMException("blocked", "NotAllowedError");
		});

		expect(registerSiteSearchTool({ registerTool }, config, "https://example.com")).toBe(false);
		warn.mockRestore();
	});

	it("reports a rejected registration instead of leaving the promise unhandled", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registerTool = vi.fn(async () => {
			throw new DOMException("duplicate", "InvalidStateError");
		});

		registerSiteSearchTool({ registerTool }, config, "https://example.com");

		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		warn.mockRestore();
	});
});
