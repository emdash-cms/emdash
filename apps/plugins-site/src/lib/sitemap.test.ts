import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET } from "../pages/sitemap.xml.js";
import { searchCatalog } from "./catalog.js";

vi.mock("./catalog.js", () => ({ searchCatalog: vi.fn() }));

describe("sitemap.xml", () => {
	it("answers 503 rather than an empty sitemap when the registry fails", async () => {
		vi.mocked(searchCatalog).mockResolvedValue({
			error: new Error("Failed to search the registry: Bad Gateway"),
		});

		const response = await GET({ site: new URL("https://plugins.emdashcms.com") } as APIContext);

		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBeNull();
	});
});
