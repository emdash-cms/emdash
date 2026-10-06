import { describe, expect, it } from "vitest";

import { resolveBlueskyPostUrl } from "../src/astro/bluesky-url.js";

describe("resolveBlueskyPostUrl", () => {
	it("passes through a bsky.app post URL unchanged", () => {
		const url = "https://bsky.app/profile/alice.bsky.social/post/3juwcxjcku52k";
		expect(resolveBlueskyPostUrl(url)).toBe(url);
	});

	it("passes through a staging.bsky.app post URL unchanged", () => {
		const url = "https://staging.bsky.app/profile/did:plc:abc123/post/3juwcxjcku52k";
		expect(resolveBlueskyPostUrl(url)).toBe(url);
	});

	it("converts an AT-URI to a bsky.app post URL", () => {
		const atUri = "at://did:plc:abc123/app.bsky.feed.post/3juwcxjcku52k";
		expect(resolveBlueskyPostUrl(atUri)).toBe(
			"https://bsky.app/profile/did:plc:abc123/post/3juwcxjcku52k",
		);
	});

	it("trims surrounding whitespace before matching", () => {
		const atUri = "  at://did:plc:abc123/app.bsky.feed.post/3juwcxjcku52k  ";
		expect(resolveBlueskyPostUrl(atUri)).toBe(
			"https://bsky.app/profile/did:plc:abc123/post/3juwcxjcku52k",
		);
	});

	it("rejects an AT-URI for a non-post collection", () => {
		const atUri = "at://did:plc:abc123/app.bsky.feed.like/3juwcxjcku52k";
		expect(resolveBlueskyPostUrl(atUri)).toBeNull();
	});

	it("rejects an unrelated URL", () => {
		expect(resolveBlueskyPostUrl("https://example.com/not-bluesky")).toBeNull();
	});

	it("rejects garbage input", () => {
		expect(resolveBlueskyPostUrl("not a url at all")).toBeNull();
	});
});
