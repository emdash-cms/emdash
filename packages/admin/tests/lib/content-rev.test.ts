/**
 * Regression test for #2121: the admin content API must round-trip `_rev`.
 *
 * The content API returns `_rev` on reads and honours it on writes (409 on a
 * stale token). Before the fix, `ContentItem`/`UpdateContentInput` had no
 * `_rev` field, so the admin dropped the token on read and never sent it on
 * save — every editor PUT was a blind write that could silently overwrite a
 * newer draft revision.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchContent, updateContent } from "../../src/lib/api/content";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("content _rev round-trip (#2121)", () => {
	it("fetchContent surfaces the server-provided _rev on the item", async () => {
		// The server returns `_rev` at the envelope level (`{ item, _rev }`),
		// NOT inside `item`. The client must attach it to the returned item so
		// the editor can echo it back on save. If the client stops doing that,
		// this test fails — the mock only provides the token at the top level.
		const item = { id: "01ABC", type: "pages", data: { title: "Hi" } };
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ success: true, data: { item, _rev: "djE6dDE=" } }));

		const fetched = await fetchContent("pages", "01ABC");
		expect(fetched._rev).toBe("djE6dDE=");
	});

	it("updateContent sends _rev in the request body", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ success: true, data: { item: { id: "01ABC" }, _rev: "djI6dDI=" } }),
			);
		globalThis.fetch = fetchSpy;

		await updateContent("pages", "01ABC", { data: { title: "New" }, _rev: "djE6dDE=" });

		const [, init] = fetchSpy.mock.calls[0]!;
		const sent = JSON.parse(init.body as string);
		expect(sent._rev).toBe("djE6dDE=");
	});

	it("omits _rev for a blind write when none was read", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(jsonResponse({ success: true, data: { item: { id: "01ABC" } } }));
		globalThis.fetch = fetchSpy;

		await updateContent("pages", "01ABC", { data: { title: "New" } });

		const [, init] = fetchSpy.mock.calls[0]!;
		const sent = JSON.parse(init.body as string);
		expect("_rev" in sent).toBe(false);
	});
});
