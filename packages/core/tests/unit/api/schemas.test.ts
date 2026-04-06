import { describe, it, expect } from "vitest";

import {
	contentUpdateBody,
	createCollectionBody,
	updateCollectionBody,
	httpUrl,
} from "../../../src/api/schemas/index.js";

const SLUG_PLACEHOLDER_RE = /\{slug\}/;

describe("contentUpdateBody schema", () => {
	it("should pass through skipRevision when present", () => {
		const input = {
			data: { title: "Hello" },
			skipRevision: true,
		};
		const result = contentUpdateBody.parse(input);
		expect(result.skipRevision).toBe(true);
	});

	it("should accept updates without skipRevision", () => {
		const input = {
			data: { title: "Hello" },
		};
		const result = contentUpdateBody.parse(input);
		expect(result.skipRevision).toBeUndefined();
	});
});

describe("httpUrl validator", () => {
	it("accepts http URLs", () => {
		expect(httpUrl.parse("http://example.com")).toBe("http://example.com");
	});

	it("accepts https URLs", () => {
		expect(httpUrl.parse("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
	});

	it("rejects javascript: URIs", () => {
		expect(() => httpUrl.parse("javascript:alert(1)")).toThrow();
	});

	it("rejects data: URIs", () => {
		expect(() => httpUrl.parse("data:text/html,<script>alert(1)</script>")).toThrow();
	});

	it("rejects ftp: URIs", () => {
		expect(() => httpUrl.parse("ftp://example.com")).toThrow();
	});

	it("rejects empty string", () => {
		expect(() => httpUrl.parse("")).toThrow();
	});

	it("rejects non-URL strings", () => {
		expect(() => httpUrl.parse("not a url")).toThrow();
	});

	it("is case-insensitive for scheme", () => {
		expect(httpUrl.parse("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
	});
});

describe("createCollectionBody urlPattern validation", () => {
	it("rejects urlPattern without {slug}", () => {
		expect(() =>
			createCollectionBody.parse({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/broken",
			}),
		).toThrow(SLUG_PLACEHOLDER_RE);
	});

	it("accepts urlPattern with {slug}", () => {
		const result = createCollectionBody.parse({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
		});
		expect(result.urlPattern).toBe("/blog/{slug}");
	});

	it("accepts omitted urlPattern", () => {
		const result = createCollectionBody.parse({
			slug: "posts",
			label: "Posts",
		});
		expect(result.urlPattern).toBeUndefined();
	});
});

describe("updateCollectionBody urlPattern validation", () => {
	it("rejects urlPattern without {slug}", () => {
		expect(() => updateCollectionBody.parse({ urlPattern: "/blog/broken" })).toThrow(
			SLUG_PLACEHOLDER_RE,
		);
	});

	it("accepts null urlPattern (clear the pattern)", () => {
		const result = updateCollectionBody.parse({ urlPattern: null });
		expect(result.urlPattern).toBeNull();
	});
});
