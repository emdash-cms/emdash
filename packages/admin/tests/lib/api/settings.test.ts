import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSettings } from "../../../src/lib/api/index.js";

describe("fetchSettings", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("leaves the staging status out of settings that forms save back", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { title: "My Blog", staging: true } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		expect(await fetchSettings()).toEqual({ title: "My Blog" });
	});
});
