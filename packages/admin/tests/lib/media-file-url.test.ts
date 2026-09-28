import { describe, expect, it } from "vitest";

import { localMediaFileUrl } from "../../src/lib/media-utils";

describe("localMediaFileUrl", () => {
	it("keeps the slashes of a key stored with folders, so the [...key] route matches it", () => {
		expect(localMediaFileUrl("2026/08/photo.jpg")).toBe(
			"/_emdash/api/media/file/2026/08/photo.jpg",
		);
	});

	it("leaves a plain media ID or key unchanged", () => {
		expect(localMediaFileUrl("01HXYZ.jpg")).toBe("/_emdash/api/media/file/01HXYZ.jpg");
	});

	it("encodes query, fragment and percent characters inside each segment", () => {
		const url = localMediaFileUrl("uploads/a?b#c%d e.png");

		expect(url).toBe("/_emdash/api/media/file/uploads/a%3Fb%23c%25d%20e.png");
		const parsed = new URL(url, "https://example.com");
		expect(parsed.search).toBe("");
		expect(parsed.hash).toBe("");
	});

	it.each(["../settings", "a/../../api/settings", "./photo.jpg", "a//b.jpg", "/leading.jpg"])(
		"encodes %s whole so the path cannot leave the media route",
		(key) => {
			const url = localMediaFileUrl(key);

			expect(url).toBe(`/_emdash/api/media/file/${encodeURIComponent(key)}`);
			expect(
				new URL(url, "https://example.com").pathname.startsWith("/_emdash/api/media/file/"),
			).toBe(true);
		},
	);
});
