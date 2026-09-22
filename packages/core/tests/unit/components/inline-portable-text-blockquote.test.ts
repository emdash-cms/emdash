/**
 * Inline editor blockquote grouping tests (#1884).
 *
 * Mirrors tests/unit/converters/blockquote-grouping.test.ts against the
 * inline (visual-editing) editor's own PT ⇄ PM converters: consecutive
 * blockquote-styled Portable Text blocks must load as ONE blockquote
 * node, and the PT → PM → PT round-trip must be stable so a merged
 * quote doesn't split again on reload.
 */

import { describe, it, expect } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

function quoteBlock(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "blockquote",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

function normalBlock(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

describe("blockquote grouping (inline editor seam)", () => {
	it("merges consecutive blockquote blocks into one blockquote node", () => {
		const pm = portableTextToPM([quoteBlock("q1", "First"), quoteBlock("q2", "Second")]);

		expect(pm.content).toHaveLength(1);
		const quote = pm.content?.[0] as { type: string; content?: Array<{ type: string }> };
		expect(quote.type).toBe("blockquote");
		expect(quote.content).toHaveLength(2);
		expect(quote.content?.every((p) => p.type === "paragraph")).toBe(true);
	});

	it("does not merge blockquotes separated by other blocks", () => {
		const pm = portableTextToPM([
			quoteBlock("q1", "First"),
			normalBlock("n1", "Between"),
			quoteBlock("q2", "Second"),
		]);

		const types = (pm.content ?? []).map((n) => (n as { type: string }).type);
		expect(types).toEqual(["blockquote", "paragraph", "blockquote"]);
	});

	it("is stable through PT → PM → PT (no split on reload)", () => {
		const original = [quoteBlock("q1", "First"), quoteBlock("q2", "Second")];

		const once = pmToPortableText(portableTextToPM(original)) as Array<{
			style?: string;
			children?: Array<{ text?: string }>;
		}>;
		expect(once).toHaveLength(2);
		expect(once.every((b) => b.style === "blockquote")).toBe(true);
		expect(once.map((b) => b.children?.[0]?.text)).toEqual(["First", "Second"]);

		// Second round-trip must not change the shape further.
		const twice = pmToPortableText(portableTextToPM(once as never));
		expect(twice).toHaveLength(2);
	});

	it("keeps a single blockquote block as one quote with one paragraph", () => {
		const pm = portableTextToPM([quoteBlock("q1", "Only")]);

		expect(pm.content).toHaveLength(1);
		const quote = pm.content?.[0] as { type: string; content?: unknown[] };
		expect(quote.type).toBe("blockquote");
		expect(quote.content).toHaveLength(1);
	});
});
