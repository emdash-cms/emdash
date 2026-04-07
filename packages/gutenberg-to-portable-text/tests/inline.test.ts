/**
 * Tests for inline HTML parsing
 */

import { describe, it, expect } from "vitest";

import {
	parseInlineContent,
	extractText,
	extractAlt,
	extractCaption,
	extractSrc,
} from "../src/inline.js";

let keyCounter = 0;
const generateKey = () => `key-${++keyCounter}`;

const NEWLINE_PATTERN = /\n/g;

describe("parseInlineContent", () => {
	describe("plain text", () => {
		it("parses plain text", () => {
			const result = parseInlineContent("Hello world", generateKey);

			expect(result.children).toHaveLength(1);
			expect(result.children[0]).toMatchObject({
				_type: "span",
				text: "Hello world",
			});
			expect(result.markDefs).toHaveLength(0);
		});

		it("handles empty string", () => {
			const result = parseInlineContent("", generateKey);

			expect(result.children).toHaveLength(1);
			expect(result.children[0]).toMatchObject({
				_type: "span",
				text: "",
			});
		});

		it("handles whitespace-only string", () => {
			const result = parseInlineContent("   ", generateKey);

			expect(result.children).toHaveLength(1);
			expect(result.children[0]?.text).toBe("   ");
		});

		it("preserves newlines in text", () => {
			const result = parseInlineContent("line1\nline2", generateKey);

			// Should have one span with newline appended, then another span
			expect(result.children.length).toBeGreaterThanOrEqual(1);
			const fullText = result.children.map((c) => c.text).join("");
			expect(fullText).toContain("line1");
			expect(fullText).toContain("line2");
		});
	});

	describe("basic formatting", () => {
		it("parses <strong> tags", () => {
			const result = parseInlineContent("Hello <strong>bold</strong> world", generateKey);

			expect(result.children).toHaveLength(3);
			expect(result.children[0]).toMatchObject({ text: "Hello " });
			expect(result.children[1]).toMatchObject({
				text: "bold",
				marks: ["strong"],
			});
			expect(result.children[2]).toMatchObject({ text: " world" });
		});

		it("parses <b> tags as strong", () => {
			const result = parseInlineContent("Hello <b>bold</b> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "bold",
				marks: ["strong"],
			});
		});

		it("parses <em> tags", () => {
			const result = parseInlineContent("Hello <em>italic</em> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "italic",
				marks: ["em"],
			});
		});

		it("parses <i> tags as em", () => {
			const result = parseInlineContent("Hello <i>italic</i> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "italic",
				marks: ["em"],
			});
		});

		it("parses <u> tags", () => {
			const result = parseInlineContent("Hello <u>underline</u> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "underline",
				marks: ["underline"],
			});
		});

		it("parses <s> tags as strike-through", () => {
			const result = parseInlineContent("Hello <s>strikethrough</s> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "strikethrough",
				marks: ["strike-through"],
			});
		});

		it("parses <del> tags as strike-through", () => {
			const result = parseInlineContent("Hello <del>deleted</del> world", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "deleted",
				marks: ["strike-through"],
			});
		});

		it("parses <code> tags", () => {
			const result = parseInlineContent("Use <code>const x = 1</code> for variables", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "const x = 1",
				marks: ["code"],
			});
		});

		it("parses <sup> tags", () => {
			const result = parseInlineContent("x<sup>2</sup>", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "2",
				marks: ["superscript"],
			});
		});

		it("parses <sub> tags", () => {
			const result = parseInlineContent("H<sub>2</sub>O", generateKey);

			expect(result.children[1]).toMatchObject({
				text: "2",
				marks: ["subscript"],
			});
		});
	});

	describe("nested formatting", () => {
		it("handles nested strong and em", () => {
			const result = parseInlineContent("<strong><em>bold italic</em></strong>", generateKey);

			expect(result.children).toHaveLength(1);
			expect(result.children[0]).toMatchObject({
				text: "bold italic",
				marks: expect.arrayContaining(["strong", "em"]),
			});
		});

		it("handles deeply nested marks", () => {
			const result = parseInlineContent("<strong><em><code>code</code></em></strong>", generateKey);

			expect(result.children[0]?.marks).toContain("strong");
			expect(result.children[0]?.marks).toContain("em");
			expect(result.children[0]?.marks).toContain("code");
		});

		it("handles mixed content with nested marks", () => {
			const result = parseInlineContent(
				"Start <strong>bold <em>bold-italic</em> bold</strong> end",
				generateKey,
			);

			expect(result.children.length).toBeGreaterThanOrEqual(4);
			// Find the bold-italic span
			const boldItalic = result.children.find(
				(c) => c.marks?.includes("strong") && c.marks?.includes("em"),
			);
			expect(boldItalic?.text).toBe("bold-italic");
		});
	});

	describe("links", () => {
		it("parses simple links", () => {
			const result = parseInlineContent(
				'Visit <a href="https://example.com">our site</a>',
				generateKey,
			);

			expect(result.markDefs).toHaveLength(1);
			expect(result.markDefs[0]).toMatchObject({
				_type: "link",
				href: "https://example.com",
			});

			const linkSpan = result.children.find((c) =>
				c.marks?.includes(result.markDefs[0]?._key ?? ""),
			);
			expect(linkSpan?.text).toBe("our site");
		});

		it("handles links with target=_blank", () => {
			const result = parseInlineContent(
				'<a href="https://example.com" target="_blank">link</a>',
				generateKey,
			);

			expect(result.markDefs[0]).toMatchObject({
				_type: "link",
				href: "https://example.com",
				blank: true,
			});
		});

		it("deduplicates identical links", () => {
			const result = parseInlineContent(
				'<a href="https://example.com">link1</a> and <a href="https://example.com">link2</a>',
				generateKey,
			);

			expect(result.markDefs).toHaveLength(1);

			const linkKey = result.markDefs[0]?._key;
			const linkSpans = result.children.filter((c) => c.marks?.includes(linkKey ?? ""));
			expect(linkSpans).toHaveLength(2);
		});

		it("creates separate markDefs for different links", () => {
			const result = parseInlineContent(
				'<a href="https://a.com">link1</a> and <a href="https://b.com">link2</a>',
				generateKey,
			);

			expect(result.markDefs).toHaveLength(2);
			expect(result.markDefs.map((m) => m.href)).toContain("https://a.com");
			expect(result.markDefs.map((m) => m.href)).toContain("https://b.com");
		});

		it("handles links with formatting inside", () => {
			const result = parseInlineContent(
				'<a href="https://example.com"><strong>bold link</strong></a>',
				generateKey,
			);

			const span = result.children.find((c) => c.text === "bold link");
			expect(span?.marks).toContain("strong");
			expect(span?.marks?.length).toBe(2); // strong + link key
		});

		it("handles links with empty href", () => {
			const result = parseInlineContent('<a href="">empty link</a>', generateKey);

			expect(result.markDefs).toHaveLength(1);
			expect(result.markDefs[0]).toMatchObject({
				_type: "link",
				href: "",
			});

			const linkSpan = result.children.find((c) =>
				c.marks?.includes(result.markDefs[0]?._key ?? ""),
			);
			expect(linkSpan?.text).toBe("empty link");
		});

		it("ignores unknown schemes in links", () => {
			const result = parseInlineContent('<a href="ftp://foo.bar">bad link</a>', generateKey);

			expect(result.markDefs).toHaveLength(1);
			expect(result.markDefs[0]).toMatchObject({
				_type: "link",
				href: "",
			});

			const linkSpan = result.children.find((c) => c.marks?.includes(result.markDefs[0]!._key));
			expect(linkSpan?.text).toBe("bad link");
		});
	});

	describe("line breaks", () => {
		it("handles <br> tags", () => {
			const result = parseInlineContent("line1<br>line2", generateKey);

			const fullText = result.children.map((c) => c.text).join("");
			expect(fullText).toContain("line1");
			expect(fullText).toContain("\n");
			expect(fullText).toContain("line2");
		});

		it("handles self-closing <br /> tags", () => {
			const result = parseInlineContent("line1<br />line2", generateKey);

			const fullText = result.children.map((c) => c.text).join("");
			expect(fullText).toContain("\n");
		});

		it("handles multiple consecutive <br> tags", () => {
			const result = parseInlineContent("a<br><br>b", generateKey);

			const fullText = result.children.map((c) => c.text).join("");
			expect(fullText.match(NEWLINE_PATTERN)?.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("block wrapper stripping", () => {
		it("strips <p> wrapper", () => {
			const result = parseInlineContent("<p>content</p>", generateKey);

			expect(result.children).toHaveLength(1);
			expect(result.children[0]?.text).toBe("content");
		});

		it("strips heading wrappers", () => {
			const result = parseInlineContent("<h2>heading</h2>", generateKey);

			expect(result.children[0]?.text).toBe("heading");
		});

		it("strips <li> wrapper", () => {
			const result = parseInlineContent("<li>list item</li>", generateKey);

			expect(result.children[0]?.text).toBe("list item");
		});

		it("preserves content when wrapper has attributes", () => {
			const result = parseInlineContent('<p class="intro">content</p>', generateKey);

			expect(result.children[0]?.text).toBe("content");
		});
	});
});

describe("extractText", () => {
	it("extracts plain text", () => {
		expect(extractText("Hello world")).toBe("Hello world");
	});

	it("strips HTML tags", () => {
		expect(extractText("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
	});

	it("handles nested elements", () => {
		expect(extractText("<div><p>Nested <em>text</em></p></div>")).toBe("Nested text");
	});

	it("handles empty string", () => {
		expect(extractText("")).toBe("");
	});
});

describe("extractAlt", () => {
	it("extracts alt from img tag", () => {
		expect(extractAlt('<img src="photo.jpg" alt="A photo">')).toBe("A photo");
	});

	it("handles missing alt", () => {
		expect(extractAlt('<img src="photo.jpg">')).toBeUndefined();
	});

	it("handles empty alt", () => {
		expect(extractAlt('<img src="photo.jpg" alt="">')).toBe("");
	});

	it("handles single quotes", () => {
		expect(extractAlt("<img src='photo.jpg' alt='A photo'>")).toBe("A photo");
	});
});

describe("extractCaption", () => {
	it("extracts caption from figcaption", () => {
		expect(extractCaption("<figure><img><figcaption>My caption</figcaption></figure>")).toBe(
			"My caption",
		);
	});

	it("strips HTML from caption", () => {
		expect(
			extractCaption("<figure><figcaption>Caption with <em>formatting</em></figcaption></figure>"),
		).toBe("Caption with formatting");
	});

	it("handles missing figcaption", () => {
		expect(extractCaption("<figure><img></figure>")).toBeUndefined();
	});
});

describe("extractSrc", () => {
	it("extracts src from img tag", () => {
		expect(extractSrc('<img src="https://example.com/photo.jpg">')).toBe(
			"https://example.com/photo.jpg",
		);
	});

	it("handles relative URLs", () => {
		expect(extractSrc('<img src="/uploads/photo.jpg">')).toBe("/uploads/photo.jpg");
	});

	it("handles missing src", () => {
		expect(extractSrc("<img alt='no source'>")).toBeUndefined();
	});
});
