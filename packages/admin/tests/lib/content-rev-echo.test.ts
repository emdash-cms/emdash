import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	_clearKnownRevs,
	_getKnownRev,
	fetchContent,
	updateContent,
} from "../../src/lib/api/content";

const ITEM = {
	id: "content-1",
	type: "pages",
	slug: "home",
	status: "draft",
	locale: "en",
	translationGroup: null,
	data: { title: "Hello" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: "rev-9",
};

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify({ data }), { status });
}

describe("admin content client _rev echo (#2121)", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		_clearKnownRevs();
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		_clearKnownRevs();
	});

	it("captures _rev from a GET and echoes it into the next PUT body", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWE=" }));
		await fetchContent("pages", "content-1");
		expect(_getKnownRev("content-1")).toBe("cmV2LWE=");

		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWI=" }));
		await updateContent("pages", "content-1", { data: { title: "Edited" } });

		const [, init] = fetchSpy.mock.calls[1]!;
		expect(init.method).toBe("PUT");
		expect(JSON.parse(init.body)).toEqual({ data: { title: "Edited" }, _rev: "cmV2LWE=" });
		// The PUT response's fresh token replaces the old one for the next save.
		expect(_getKnownRev("content-1")).toBe("cmV2LWI=");
	});

	it("sends no _rev when none is known (backwards-compatible blind write)", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWM=" }));
		await updateContent("pages", "content-1", { data: { title: "First" } });

		const [, init] = fetchSpy.mock.calls[0]!;
		expect(JSON.parse(init.body)).toEqual({ data: { title: "First" } });
	});

	it("drops the stale token on a 409 so a refetch can re-arm", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWQ=" }));
		await fetchContent("pages", "content-1");

		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { message: "version conflict" } }), { status: 409 }),
		);
		await expect(
			updateContent("pages", "content-1", { data: { title: "Stale edit" } }),
		).rejects.toThrow();
		expect(_getKnownRev("content-1")).toBeUndefined();

		// The refetch re-arms concurrency checking for the next save.
		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWU=" }));
		await fetchContent("pages", "content-1");
		expect(_getKnownRev("content-1")).toBe("cmV2LWU=");
	});

	it("keeps autosave-style updates concurrency-checked too", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWY=" }));
		await fetchContent("pages", "content-1");

		fetchSpy.mockResolvedValueOnce(jsonResponse({ item: ITEM, _rev: "cmV2LWc=" }));
		await updateContent("pages", "content-1", {
			data: { title: "Autosaved" },
			skipRevision: true,
		});
		const [, init] = fetchSpy.mock.calls[1]!;
		expect(JSON.parse(init.body)._rev).toBe("cmV2LWY=");
		expect(JSON.parse(init.body).skipRevision).toBe(true);
	});
});
