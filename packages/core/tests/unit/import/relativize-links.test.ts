/**
 * Internal links in imported content must be rewritten to root-relative
 * URLs — otherwise migrated posts keep sending readers back to the old
 * WordPress domain (live-migration finding: an imported post linked to
 * `https://techgarage.blog/companies/google/` instead of the new site).
 */

import type { PortableTextBlock } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, it, expect } from "vitest";

import { relativizeContentLinks } from "../../../src/import/utils.js";

const SITE = "https://techgarage.blog";

function textBlock(markDefs: Array<Record<string, unknown>>): PortableTextBlock {
	return {
		_type: "block",
		_key: "b1",
		children: [{ _type: "span", _key: "s1", text: "x", marks: ["l1"] }],
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
		markDefs: markDefs as never,
	};
}

describe("relativizeContentLinks", () => {
	it("rewrites internal link markDefs, leaves external and media links alone", () => {
		const blocks = [
			textBlock([
				{ _type: "link", _key: "l1", href: `${SITE}/companies/google/` },
				{ _type: "link", _key: "l2", href: "https://www.techgarage.blog/posts/a?x=1#frag" },
				{ _type: "link", _key: "l3", href: "https://example.com/other" },
				{ _type: "link", _key: "l4", href: `${SITE}/wp-content/uploads/img.jpg` },
				{ _type: "link", _key: "l5", href: "mailto:hi@techgarage.blog" },
			]),
		];

		relativizeContentLinks(blocks, SITE);

		const defs = (blocks[0] as { markDefs: Array<{ href: string }> }).markDefs;
		expect(defs[0]?.href).toBe("/companies/google/");
		// www-insensitive, query + hash preserved
		expect(defs[1]?.href).toBe("/posts/a?x=1#frag");
		expect(defs[2]?.href).toBe("https://example.com/other");
		// media stays absolute for the media pass's URL map
		expect(defs[3]?.href).toBe(`${SITE}/wp-content/uploads/img.jpg`);
		expect(defs[4]?.href).toBe("mailto:hi@techgarage.blog");
	});

	it("rewrites image click-through links, buttons, and raw html blocks", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "i1",
				asset: { _type: "reference", _ref: `${SITE}/wp-content/uploads/a.jpg` },
				link: `${SITE}/gallery/`,
			},
			{ _type: "button", _key: "bt1", text: "Go", url: `${SITE}/pricing/` },
			{
				_type: "htmlBlock",
				_key: "h1",
				html: `<a href="${SITE}/about/">About</a> <a href="https://example.com/">ext</a>`,
			},
		];

		relativizeContentLinks(blocks, SITE);

		expect(blocks[0]).toMatchObject({
			asset: { _ref: `${SITE}/wp-content/uploads/a.jpg` }, // untouched
			link: "/gallery/",
		});
		expect(blocks[1]).toMatchObject({ url: "/pricing/" });
		expect(blocks[2]).toMatchObject({
			html: '<a href="/about/">About</a> <a href="https://example.com/">ext</a>',
		});
	});

	it("handles single-quoted, unquoted, and uppercase hrefs in raw html", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "htmlBlock",
				_key: "h1",
				html: `<a href='${SITE}/single/'>s</a> <a href=${SITE}/bare/ class="x">b</a> <a HREF="${SITE}/upper/">u</a> <a href='https://example.com/keep'>ext</a>`,
			},
		];

		relativizeContentLinks(blocks, SITE);

		expect(blocks[0]).toMatchObject({
			html: `<a href="/single/">s</a> <a href="/bare/" class="x">b</a> <a href="/upper/">u</a> <a href='https://example.com/keep'>ext</a>`,
		});
	});

	it("recurses into columns and rewrites table cell links", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "columns",
				_key: "c1",
				columns: [
					{
						_type: "column",
						_key: "co1",
						content: [textBlock([{ _type: "link", _key: "l1", href: `${SITE}/nested/` }])],
					},
				],
			},
			{
				_type: "table",
				_key: "t1",
				rows: [
					{
						_type: "tableRow",
						_key: "r1",
						cells: [
							{
								_type: "tableCell",
								_key: "ce1",
								content: [],
								// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
								markDefs: [{ _type: "link", _key: "l2", href: `${SITE}/cell/` }] as never,
							},
						],
					},
				],
			},
		];

		relativizeContentLinks(blocks, SITE);

		expect(JSON.stringify(blocks)).toContain('"/nested/"');
		expect(JSON.stringify(blocks)).toContain('"/cell/"');
		expect(JSON.stringify(blocks)).not.toContain("techgarage.blog");
	});

	it("is a no-op for an unparseable site url", () => {
		const blocks = [textBlock([{ _type: "link", _key: "l1", href: `${SITE}/a/` }])];
		relativizeContentLinks(blocks, "not a url");
		expect((blocks[0] as { markDefs: Array<{ href: string }> }).markDefs[0]?.href).toBe(
			`${SITE}/a/`,
		);
	});
});
