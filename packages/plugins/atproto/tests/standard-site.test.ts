import { describe, it, expect } from "vitest";

import { buildPublication, buildDocument, extractPlainText } from "../src/standard-site.js";

describe("buildPublication", () => {
	it("builds a publication record with required fields", () => {
		const pub = buildPublication("https://myblog.com", "My Blog");
		expect(pub).toEqual({
			$type: "site.standard.publication",
			url: "https://myblog.com",
			name: "My Blog",
		});
	});

	it("strips trailing slash from URL", () => {
		const pub = buildPublication("https://myblog.com/", "My Blog");
		expect(pub.url).toBe("https://myblog.com");
	});

	it("includes description when provided", () => {
		const pub = buildPublication("https://myblog.com", "My Blog", "A personal blog");
		expect(pub.description).toBe("A personal blog");
	});

	it("omits description when not provided", () => {
		const pub = buildPublication("https://myblog.com", "My Blog");
		expect(pub).not.toHaveProperty("description");
	});
});

describe("buildDocument", () => {
	const baseOpts = {
		publicationUri: "at://did:plc:abc123/site.standard.publication/3lwafz",
		content: {
			title: "Hello World",
			slug: "hello-world",
			excerpt: "A great post",
			published_at: "2025-01-15T12:00:00.000Z",
			updated_at: "2025-01-16T10:00:00.000Z",
			body: "<p>This is the body</p>",
			tags: ["tech", "web"],
		},
	};

	it("builds a document with all fields", () => {
		const doc = buildDocument(baseOpts);
		expect(doc.$type).toBe("site.standard.document");
		expect(doc.site).toBe(baseOpts.publicationUri);
		expect(doc.title).toBe("Hello World");
		expect(doc.path).toBe("/hello-world");
		expect(doc.description).toBe("A great post");
		expect(doc.publishedAt).toBe("2025-01-15T12:00:00.000Z");
		expect(doc.updatedAt).toBe("2025-01-16T10:00:00.000Z");
		expect(doc.tags).toEqual(["tech", "web"]);
		expect(doc.textContent).toBe("This is the body");
	});

	it("uses excerpt field for description", () => {
		const doc = buildDocument({
			...baseOpts,
			content: { ...baseOpts.content, excerpt: undefined, description: "fallback desc" },
		});
		expect(doc.description).toBe("fallback desc");
	});

	it("defaults title to Untitled", () => {
		const doc = buildDocument({
			...baseOpts,
			content: { published_at: "2025-01-15T12:00:00.000Z" },
		});
		expect(doc.title).toBe("Untitled");
	});

	it("omits path when slug is missing", () => {
		const doc = buildDocument({
			...baseOpts,
			content: { title: "No Slug", published_at: "2025-01-15T12:00:00.000Z" },
		});
		expect(doc.path).toBeUndefined();
	});

	it("reads slug from content.data", () => {
		const doc = buildDocument({
			...baseOpts,
			collection: "posts",
			content: {
				title: "Nested Slug",
				data: { slug: "nested-slug" },
				published_at: "2025-01-15T12:00:00.000Z",
			},
		});
		expect(doc.path).toBe("/posts/nested-slug");
	});

	it("includes bskyPostRef when provided", () => {
		const doc = buildDocument({
			...baseOpts,
			bskyPostRef: { uri: "at://did:plc:xyz/app.bsky.feed.post/abc", cid: "bafyrei123" },
		});
		expect(doc.bskyPostRef).toEqual({
			uri: "at://did:plc:xyz/app.bsky.feed.post/abc",
			cid: "bafyrei123",
		});
	});

	it("includes coverImage when provided", () => {
		const blob = {
			$type: "blob" as const,
			ref: { $link: "bafkrei123" },
			mimeType: "image/jpeg",
			size: 45000,
		};
		const doc = buildDocument({
			...baseOpts,
			coverImageBlob: blob,
		});
		expect(doc.coverImage).toBe(blob);
	});

	it("handles tag objects with name property", () => {
		const doc = buildDocument({
			...baseOpts,
			content: {
				...baseOpts.content,
				tags: [{ name: "javascript" }, { name: "#python" }],
			},
		});
		expect(doc.tags).toEqual(["javascript", "python"]);
	});

	it("strips # prefix from string tags", () => {
		const doc = buildDocument({
			...baseOpts,
			content: { ...baseOpts.content, tags: ["#tech", "web", "#dev"] },
		});
		expect(doc.tags).toEqual(["tech", "web", "dev"]);
	});
});

describe("extractPlainText", () => {
	it("strips HTML tags", () => {
		const text = extractPlainText({ body: "<p>Hello <strong>world</strong></p>" });
		expect(text).toBe("Hello world");
	});

	it("decodes HTML entities", () => {
		const text = extractPlainText({ body: "Tom &amp; Jerry &lt;3 &gt; &quot;fun&quot;" });
		expect(text).toBe('Tom & Jerry <3 > "fun"');
	});

	it("collapses whitespace", () => {
		const text = extractPlainText({ body: "<p>Hello</p>\n\n<p>World</p>" });
		expect(text).toBe("Hello World");
	});

	it("tries body, content, then text fields", () => {
		expect(extractPlainText({ body: "from body" })).toBe("from body");
		expect(extractPlainText({ content: "from content" })).toBe("from content");
		expect(extractPlainText({ text: "from text" })).toBe("from text");
	});

	it("returns undefined when no content field exists", () => {
		expect(extractPlainText({ title: "just a title" })).toBeUndefined();
	});

	it("returns undefined for empty body", () => {
		expect(extractPlainText({ body: "" })).toBeUndefined();
	});

	it("handles &nbsp;", () => {
		const text = extractPlainText({ body: "hello&nbsp;world" });
		expect(text).toBe("hello world");
	});

	it("does not double-decode &amp;lt;", () => {
		// &amp;lt; should become &lt; (literal text), not <
		const text = extractPlainText({ body: "code: &amp;lt;div&amp;gt;" });
		expect(text).toBe("code: &lt;div&gt;");
	});

	it("truncates very long text content", () => {
		const longBody = "A".repeat(20_000);
		const text = extractPlainText({ body: longBody });
		expect(text!.length).toBeLessThanOrEqual(10_000);
		expect(text!.endsWith("\u2026")).toBe(true);
	});
});
