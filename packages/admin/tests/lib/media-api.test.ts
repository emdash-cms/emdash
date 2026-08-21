import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaUsageAccessDeniedError, fetchMediaUsageDetails } from "../../src/lib/api/media.js";

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

describe("media usage API", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("encodes pagination and forwards cancellation for a bounded usage read", async () => {
		const controller = new AbortController();
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
					sources: [],
				},
			],
			nextCursor: "next / group",
			coverage: { scope: "all_content_collections", status: "stale" },
		};
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ success: true, data }));

		const result = await fetchMediaUsageDetails("media/one", {
			cursor: "after / group",
			limit: 50,
			signal: controller.signal,
		});

		const [input, init] = fetch.mock.calls[0]!;
		const url = new URL(requestUrl(input), window.location.origin);
		expect(url.pathname).toBe("/_emdash/api/media/media%2Fone/usage");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			cursor: "after / group",
			limit: "50",
		});
		expect(init?.signal).toBe(controller.signal);
		expect(result).toEqual(data);
		expect(result).not.toHaveProperty("count");
	});

	it("omits undefined pagination values", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				success: true,
				data: {
					items: [],
					coverage: { scope: "all_content_collections", status: "complete" },
				},
			}),
		);

		await fetchMediaUsageDetails("media-1", { cursor: undefined, limit: undefined });

		expect(requestUrl(fetch.mock.calls[0]![0])).toBe("/_emdash/api/media/media-1/usage");
	});

	it.each([401, 403])("maps %s to a private access-denied error", async (status) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{
					success: false,
					error: { code: "FORBIDDEN", message: "private server detail" },
				},
				{ status },
			),
		);

		const error = await fetchMediaUsageDetails("media-1").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MediaUsageAccessDeniedError);
		expect((error as Error).message).not.toContain("private server detail");
	});

	it("preserves ordinary API error handling", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{
					success: false,
					error: { code: "MEDIA_NOT_FOUND", message: "Media item not found" },
				},
				{ status: 404 },
			),
		);

		await expect(fetchMediaUsageDetails("missing")).rejects.toThrow("Media item not found");
	});
});
