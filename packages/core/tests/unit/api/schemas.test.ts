import { describe, it, expect } from "vitest";

import {
	contentCreateBody,
	contentUpdateBody,
	httpUrl,
	mediaUploadUrlBody,
	DEFAULT_MAX_UPLOAD_SIZE,
} from "../../../src/api/schemas/index.js";

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

	it("preserves publishedAt and createdAt when valid ISO 8601 datetimes are provided", () => {
		const result = contentCreateBody.parse({
			data: { title: "Hi" },
			publishedAt: "2019-03-15T10:30:00.000Z",
			createdAt: "2019-03-15T10:30:00.000Z",
		});
		expect(result.publishedAt).toBe("2019-03-15T10:30:00.000Z");
		expect(result.createdAt).toBe("2019-03-15T10:30:00.000Z");
	});

	it("accepts offset-suffixed ISO datetimes", () => {
		const result = contentCreateBody.parse({
			data: { title: "Hi" },
			publishedAt: "2019-03-15T10:30:00+00:00",
		});
		expect(result.publishedAt).toBe("2019-03-15T10:30:00+00:00");
	});

	it("rejects malformed datetime strings", () => {
		expect(() =>
			contentCreateBody.parse({ data: { title: "Hi" }, publishedAt: "yesterday" }),
		).toThrow();
		expect(() =>
			contentCreateBody.parse({ data: { title: "Hi" }, createdAt: "2019-03-15" }),
		).toThrow();
	});

	it("accepts null to explicitly clear the field", () => {
		const result = contentCreateBody.parse({ data: { title: "Hi" }, publishedAt: null });
		expect(result.publishedAt).toBeNull();
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

	it("preserves publishedAt when a valid ISO 8601 datetime is provided", () => {
		const result = contentUpdateBody.parse({
			data: { title: "Hi" },
			publishedAt: "2019-03-15T10:30:00.000Z",
		});
		expect(result.publishedAt).toBe("2019-03-15T10:30:00.000Z");
	});

	it("rejects malformed publishedAt strings", () => {
		expect(() =>
			contentUpdateBody.parse({ data: { title: "Hi" }, publishedAt: "yesterday" }),
		).toThrow();
	});

	it("strips createdAt — treat created_at as immutable on update", () => {
		const result = contentUpdateBody.parse({
			data: { title: "Hi" },
			createdAt: "2019-03-15T10:30:00.000Z",
		} as Parameters<typeof contentUpdateBody.parse>[0]);
		expect("createdAt" in result).toBe(false);
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

describe("mediaUploadUrlBody schema factory", () => {
	it("DEFAULT_MAX_UPLOAD_SIZE is 50 MB", () => {
		expect(DEFAULT_MAX_UPLOAD_SIZE).toBe(50 * 1024 * 1024);
	});

	it("rejects size above the configured limit", () => {
		const schema = mediaUploadUrlBody(1_000);
		expect(() =>
			schema.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 1_001 }),
		).toThrow();
	});

	it("accepts size equal to the configured limit", () => {
		const schema = mediaUploadUrlBody(1_000);
		const result = schema.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 1_000 });
		expect(result.size).toBe(1_000);
	});

	it("accepts size below the configured limit", () => {
		const schema = mediaUploadUrlBody(1_000);
		const result = schema.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 500 });
		expect(result.size).toBe(500);
	});

	it("each call returns an independent schema with its own limit", () => {
		const strict = mediaUploadUrlBody(100);
		const loose = mediaUploadUrlBody(1_000_000);
		expect(() =>
			strict.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 500 }),
		).toThrow();
		expect(() =>
			loose.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 500 }),
		).not.toThrow();
	});

	it("throws when maxSize is NaN", () => {
		expect(() => mediaUploadUrlBody(NaN)).toThrow(/maxUploadSize/);
	});

	it("throws when maxSize is 0", () => {
		expect(() => mediaUploadUrlBody(0)).toThrow(/maxUploadSize/);
	});

	it("throws when maxSize is negative", () => {
		expect(() => mediaUploadUrlBody(-1024)).toThrow(/maxUploadSize/);
	});

	it("error message uses whole MB, not fractional", () => {
		const schema = mediaUploadUrlBody(75_000_000);
		let errorMessage = "";
		try {
			schema.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 75_000_001 });
		} catch (e) {
			errorMessage = String(e);
		}
		expect(errorMessage).not.toBe("");
		expect(errorMessage).not.toMatch(/\d+\.\d+MB/);
	});

	it("error message does not overstate the limit in MB", () => {
		// 75_000_000 bytes / 1024 / 1024 ≈ 71.5 MB; floor gives 71, round gives 72
		const schema = mediaUploadUrlBody(75_000_000);
		let errorMessage = "";
		try {
			schema.parse({ filename: "a.jpg", contentType: "image/jpeg", size: 75_000_001 });
		} catch (e) {
			errorMessage = String(e);
		}
		expect(errorMessage).toContain("71MB");
	});
});
