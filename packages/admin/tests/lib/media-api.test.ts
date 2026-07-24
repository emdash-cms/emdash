import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMediaList, fetchMediaUsageDetails } from "../../src/lib/api/media";

describe("media API", () => {
	const originalFetch = globalThis.fetch;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("serializes exact usage opt-in and preserves a redacted summary response", async () => {
		const data = {
			items: [
				{
					id: "media-1",
					filename: "hero.jpg",
					mimeType: "image/jpeg",
					url: "/_emdash/api/media/file/hero.jpg",
					size: 1024,
					createdAt: "2026-07-21T10:00:00.000Z",
					usage: {
						count: null,
						coverage: {
							scope: "all_content_collections",
							status: "partial",
						},
					},
				},
			],
			nextCursor: "next-media",
		};
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await fetchMediaList({
			cursor: "after / one",
			limit: 25,
			mimeType: ["image/", "video/"],
			search: "  hero  ",
			includeUsage: true,
		});

		const [input] = fetchSpy.mock.calls[0]!;
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/_emdash/api/media");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			cursor: "after / one",
			limit: "25",
			mimeType: "image/,video/",
			q: "hero",
			includeUsage: "1",
		});
		expect(result).toEqual(data);
	});

	it("omits usage opt-in when it is false or undefined", async () => {
		fetchSpy.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ data: { items: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		await fetchMediaList({ includeUsage: false });
		await fetchMediaList();

		for (const [input] of fetchSpy.mock.calls) {
			const url = new URL(String(input), window.location.origin);
			expect(url.searchParams.has("includeUsage")).toBe(false);
		}
	});

	it("encodes the media id, serializes pagination, and unwraps nested usage details", async () => {
		const data = {
			items: [
				{
					collection: "posts",
					contentId: "post-1",
					title: "Launch notes",
					slug: "launch-notes",
					locale: "en",
					status: "published",
					scheduledAt: null,
					deletedAt: null,
					sources: [
						{
							variant: "columns",
							occurrences: [
								{
									fieldSlug: "hero",
									fieldPath: "hero",
									occurrenceIndex: 0,
									referenceType: "image_field",
								},
							],
						},
					],
				},
			],
			nextCursor: "next / group",
			coverage: { scope: "all_content_collections", status: "stale" },
		};
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await fetchMediaUsageDetails("media/one", {
			limit: 25,
			cursor: "after / group",
		});

		const [input] = fetchSpy.mock.calls[0]!;
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/_emdash/api/media/media%2Fone/usage");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "25",
			cursor: "after / group",
		});
		expect(result).toEqual(data);
		expect(result).not.toHaveProperty("count");
	});

	it("surfaces the server message for usage-detail errors", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "FORBIDDEN", message: "Usage details are unavailable" },
				}),
				{
					status: 403,
					statusText: "Forbidden",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(fetchMediaUsageDetails("media-1")).rejects.toThrow(
			"Usage details are unavailable",
		);
	});
});
