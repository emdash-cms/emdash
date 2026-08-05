/**
 * Portable Text headings must render with a slug `id` from their text so
 * same-page `#section` links work. An existing id and the block `_key` stay
 * available as additional fragment targets when the heading is renamed.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Block from "../../src/components/Block.astro";
import PortableText from "../../src/components/PortableText.astro";

function span(text: string, key = "s1") {
	return { _type: "span" as const, _key: key, text, marks: [] as string[] };
}

function headingBlock(
	text: string,
	opts: { key?: string; id?: string; style?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" } = {},
) {
	return {
		_type: "block" as const,
		_key: opts.key ?? "hk1",
		style: opts.style ?? ("h2" as const),
		...(opts.id ? { id: opts.id } : {}),
		children: [span(text)],
	};
}

const headingTag = (html: string, level = 2) =>
	html.match(new RegExp(`<h${level}\\b[^>]*>[\\s\\S]*?</h${level}>`))?.[0] ?? "";

const allIds = (html: string) =>
	Array.from(html.matchAll(/\bid="([^"]*)"/g), (m) => m[1]).filter((id): id is string => !!id);

describe("heading slug ids", () => {
	test("Block.astro slugs heading text onto id", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(Block, {
			props: {
				node: headingBlock("This is a new heading", { key: "blk_abc" }),
				index: 0,
				isInline: false,
			},
			slots: { default: "This is a new heading" },
		});
		const tag = headingTag(html);
		expect(tag).toContain('id="this-is-a-new-heading"');
		expect(tag).toContain('id="blk_abc"');
		expect(tag).toContain("This is a new heading");
	});

	test("PortableText assigns unique slugs across headings", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: {
				value: [
					headingBlock("Overview", { key: "a" }),
					headingBlock("Overview", { key: "b" }),
					{
						_type: "block",
						_key: "p",
						style: "normal",
						children: [span("body")],
					},
				],
			},
		});
		const ids = allIds(html);
		expect(ids).toContain("overview");
		expect(ids).toContain("overview-2");
		expect(ids).toContain("a");
		expect(ids).toContain("b");
		// Paragraphs must not pick up an id.
		expect(html).toMatch(/<p\b(?![^>]*\bid=)/);
	});

	test("keeps an existing id in addition to the text slug", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: {
				value: [headingBlock("Current Title", { key: "stable_key", id: "legacy-anchor" })],
			},
		});
		const ids = allIds(html);
		expect(ids).toContain("current-title");
		expect(ids).toContain("legacy-anchor");
		expect(ids).toContain("stable_key");
		// Primary id on the heading element is the text slug.
		expect(headingTag(html)).toMatch(/<h2\b[^>]*\bid="current-title"/);
	});

	test("h1–h6 all receive ids; blockquote does not", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: {
				value: [
					headingBlock("One", { key: "h1k", style: "h1" }),
					headingBlock("Two", { key: "h3k", style: "h3" }),
					{
						_type: "block",
						_key: "q",
						style: "blockquote",
						children: [span("quoted")],
					},
				],
			},
		});
		expect(headingTag(html, 1)).toContain('id="one"');
		expect(headingTag(html, 3)).toContain('id="two"');
		expect(html).toMatch(/<blockquote\b(?![^>]*\bid=)/);
	});

	test("digit-leading heading text gets a safe unique id", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: {
				value: [headingBlock("1st Post", { key: "d1" }), headingBlock("1st Post", { key: "d2" })],
			},
		});
		const ids = allIds(html);
		expect(ids).toContain("h-1st-post");
		expect(ids).toContain("h-1st-post-2");
		expect(ids).toContain("d1");
		expect(ids).toContain("d2");
		expect(headingTag(html)).toMatch(/<h2\b[^>]*\bid="h-1st-post"/);
	});
});
