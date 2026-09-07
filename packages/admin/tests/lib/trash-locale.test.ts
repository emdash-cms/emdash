import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTrashedContent } from "../../src/lib/api/content";

describe("trashed content API client", () => {
	const originalFetch = globalThis.fetch;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi
			.fn()
			.mockImplementation(
				() => new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
			);
		globalThis.fetch = fetchSpy as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("scopes the trash listing to the active locale", async () => {
		await fetchTrashedContent("posts", { locale: "fr" });

		const [url] = fetchSpy.mock.calls[0]!;
		expect(new URL(url, "http://localhost").searchParams.get("locale")).toBe("fr");
	});

	it("omits the locale param when i18n is off", async () => {
		await fetchTrashedContent("posts");

		const [url] = fetchSpy.mock.calls[0]!;
		expect(new URL(url, "http://localhost").searchParams.has("locale")).toBe(false);
	});
});
