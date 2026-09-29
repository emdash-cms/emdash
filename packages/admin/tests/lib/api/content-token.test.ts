import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discardDraft, restoreRevision, unpublishContent } from "../../../src/lib/api/index.js";

const CONTENT_ITEM = {
	id: "post_1",
	type: "posts",
	slug: "post-one",
	status: "published",
	locale: "en",
	translationGroup: null,
	data: { title: "Sample" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: "2026-01-01T00:00:00Z",
	scheduledAt: null,
	liveRevisionId: "rev-live",
	draftRevisionId: "rev-draft",
};

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify({ data: body }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Content token APIs", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("unpublishContent returns the new _rev token from the response", async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ item: CONTENT_ITEM, _rev: "rev-unpublish-1" }),
		) as typeof fetch;

		const result = await unpublishContent("posts", "post_1");
		expect(result._rev).toBe("rev-unpublish-1");
	});

	it("unpublishContent forwards the current _rev token when provided", async () => {
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		globalThis.fetch = vi.fn(async (input, init?) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push({
				url,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
			});
			return jsonResponse({ item: CONTENT_ITEM, _rev: "rev-unpublish-1" });
		}) as typeof fetch;

		await unpublishContent("posts", "post_1", { _rev: "rev-initial" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("/_emdash/api/content/posts/post_1/unpublish");
		expect(requests[0]?.body).toEqual({ _rev: "rev-initial" });
	});

	it("discardDraft returns the new _rev token from the response", async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				item: { ...CONTENT_ITEM, status: "published", draftRevisionId: null },
				_rev: "rev-discard-1",
			}),
		) as typeof fetch;

		const result = await discardDraft("posts", "post_1");
		expect(result._rev).toBe("rev-discard-1");
	});

	it("restoreRevision returns the new _rev token from the response", async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				item: { ...CONTENT_ITEM, data: { title: "Restored" } },
				_rev: "rev-restore-1",
			}),
		) as typeof fetch;

		const result = await restoreRevision("revision-old");
		expect(result._rev).toBe("rev-restore-1");
	});
});
