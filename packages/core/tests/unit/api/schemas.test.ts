import { describe, it, expect } from "vitest";

import { contentCreateBody, contentUpdateBody, httpUrl } from "../../../src/api/schemas/index.js";

describe("contentCreateBody schema", () => {
	it("accepts status 'draft'", () => {
		const result = contentCreateBody.parse({ data: { title: "Hi" }, status: "draft" });
		expect(result.status).toBe("draft");
	});

	it("accepts omitted status", () => {
		const result = contentCreateBody.parse({ data: { title: "Hi" } });
		expect(result.status).toBeUndefined();
	});

	it("rejects status 'published'", () => {
		expect(() => contentCreateBody.parse({ data: { title: "Hi" }, status: "published" })).toThrow();
	});

	it("rejects status 'scheduled'", () => {
		expect(() => contentCreateBody.parse({ data: { title: "Hi" }, status: "scheduled" })).toThrow();
	});
});

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

	it("accepts status 'draft'", () => {
		const result = contentUpdateBody.parse({ data: { title: "Hi" }, status: "draft" });
		expect(result.status).toBe("draft");
	});

	it("accepts omitted status", () => {
		const result = contentUpdateBody.parse({ data: { title: "Hi" } });
		expect(result.status).toBeUndefined();
	});

	it("rejects status 'published'", () => {
		expect(() => contentUpdateBody.parse({ data: { title: "Hi" }, status: "published" })).toThrow();
	});

	it("rejects status 'scheduled'", () => {
		expect(() => contentUpdateBody.parse({ data: { title: "Hi" }, status: "scheduled" })).toThrow();
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
