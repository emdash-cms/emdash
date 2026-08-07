/**
 * Regression tests for #1884: consecutive Portable Text blocks with
 * style "blockquote" are one quote (that's what the Gutenberg importer
 * emits for a multi-paragraph <blockquote>), but the editor converter
 * turned each block into its own blockquote node. The visible symptoms:
 * a single quote renders/edits as several disconnected quotes, and
 * merging them in the editor never survives a reload because the
 * PM → PT serializer flattens a multi-paragraph quote back into
 * consecutive blocks.
 */

import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

function quoteBlock(key: string, text: string): PortableTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "blockquote",
		children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
	};
}

describe("blockquote grouping (#1884)", () => {
	it("merges consecutive blockquote blocks into one blockquote node", () => {
		const doc = portableTextToProsemirror([
			quoteBlock("q1", "If recursive service is requested…"),
			quoteBlock("q2", "- The answer to the query…"),
		]);

		expect(doc.content).toHaveLength(1);
		const quote = doc.content[0];
		expect(quote?.type).toBe("blockquote");
		expect(quote?.content?.map((p) => p.type)).toEqual(["paragraph", "paragraph"]);
		expect(quote?.content?.[0]?.content?.[0]?.text).toBe("If recursive service is requested…");
		expect(quote?.content?.[1]?.content?.[0]?.text).toBe("- The answer to the query…");
	});

	it("does not merge blockquote blocks separated by another block", () => {
		const doc = portableTextToProsemirror([
			quoteBlock("q1", "First quote"),
			{
				_type: "block",
				_key: "p1",
				style: "normal",
				children: [{ _type: "span", _key: "p1-s", text: "Between", marks: [] }],
			},
			quoteBlock("q2", "Second quote"),
		]);

		expect(doc.content?.map((n) => n.type)).toEqual(["blockquote", "paragraph", "blockquote"]);
	});

	it("keeps a multi-paragraph quote stable through PT → PM → PT", () => {
		const original = [quoteBlock("q1", "Paragraph one"), quoteBlock("q2", "Paragraph two")];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(original));

		expect(roundTripped).toHaveLength(2);
		const [first, second] = roundTripped as PortableTextTextBlock[];
		expect(first?.style).toBe("blockquote");
		expect(second?.style).toBe("blockquote");
		expect(first?.children[0]?.text).toBe("Paragraph one");
		expect(second?.children[0]?.text).toBe("Paragraph two");

		// …and importantly, loading that output again yields ONE quote node,
		// so an editor merge doesn't revert on reload.
		const reloaded = portableTextToProsemirror(roundTripped);
		expect(reloaded.content).toHaveLength(1);
		expect(reloaded.content[0]?.type).toBe("blockquote");
	});

	it("does not group quote-styled list items into the quote run", () => {
		const listQuote: PortableTextBlock = {
			_type: "block",
			_key: "lq",
			style: "blockquote",
			listItem: "bullet",
			level: 1,
			children: [{ _type: "span", _key: "lq-s", text: "quoted bullet", marks: [] }],
		};
		const doc = portableTextToProsemirror([quoteBlock("q1", "Quote"), listQuote]);

		expect(doc.content?.map((n) => n.type)).toEqual(["blockquote", "bulletList"]);
	});
});
