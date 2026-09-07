import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMediaList } from "../../src/lib/api/media";

describe("media page API client", () => {
	const originalFetch = globalThis.fetch;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi
			.fn()
			.mockImplementation(
				() =>
					new Response(JSON.stringify({ data: { items: [], totalCount: 37 } }), { status: 200 }),
			);
		globalThis.fetch = fetchSpy as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("requests a numbered page and returns its exact total", async () => {
		const result = await fetchMediaList({ page: 1, limit: 35 });
		const [url] = fetchSpy.mock.calls[0]!;
		const requestUrl = new URL(url, "http://localhost");

		expect(Object.fromEntries(requestUrl.searchParams)).toEqual({ page: "1", limit: "35" });
		expect(result).toEqual({ items: [], totalCount: 37 });
	});

	it("serializes Main library and named-folder filters", async () => {
		const mainOptions = { page: 1, limit: 35, folderId: null };
		await fetchMediaList(mainOptions);
		await fetchMediaList({ page: 1, limit: 35, folderId: "folder/one" });

		const urls = fetchSpy.mock.calls.map(([url]) => new URL(url, "http://localhost"));
		expect(urls.map((url) => url.searchParams.get("folderId"))).toEqual(["unfiled", "folder/one"]);
	});
});
