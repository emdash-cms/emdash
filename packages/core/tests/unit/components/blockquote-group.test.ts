/**
 * Regression test for #1884 (render side): consecutive blockquote-styled
 * Portable Text blocks are one quote and must render as a single
 * <blockquote>. `groupBlockquoteRuns` merges each run into a synthetic
 * `blockquoteGroup` node consumed by BlockquoteGroup.astro.
 */

import { describe, it, expect } from "vitest";

import {
	groupBlockquoteRuns,
	type BlockquoteGroupNode,
} from "../../../src/components/portable-text-blockquote-group.js";

function block(key: string, style: string, extra: Record<string, unknown> = {}) {
	return { _type: "block", _key: key, style, children: [], ...extra };
}

describe("groupBlockquoteRuns (#1884)", () => {
	it("merges consecutive blockquote blocks into one group node", () => {
		const input = [
			block("p1", "normal"),
			block("q1", "blockquote"),
			block("q2", "blockquote"),
			block("p2", "normal"),
		];

		const result = groupBlockquoteRuns(input);

		expect(result).toHaveLength(3);
		expect(result[0]).toBe(input[0]);
		expect(result[2]).toBe(input[3]);
		const group = result[1] as BlockquoteGroupNode;
		expect(group._type).toBe("blockquoteGroup");
		expect(group._key).toBe("q1-group");
		expect(group.blocks.map((b) => b._key)).toEqual(["q1", "q2"]);
	});

	it("leaves a single blockquote block untouched", () => {
		const input = [block("q1", "blockquote")];
		expect(groupBlockquoteRuns(input)).toEqual(input);
	});

	it("does not merge runs separated by other blocks", () => {
		const input = [
			block("q1", "blockquote"),
			block("p1", "normal"),
			block("q2", "blockquote"),
			block("q3", "blockquote"),
		];

		const result = groupBlockquoteRuns(input);

		expect(result).toHaveLength(3);
		expect(result[0]).toBe(input[0]);
		expect((result[2] as BlockquoteGroupNode)._type).toBe("blockquoteGroup");
	});

	it("excludes quote-styled list items and non-block types from runs", () => {
		const input = [
			block("q1", "blockquote"),
			block("li", "blockquote", { listItem: "bullet", level: 1 }),
			{ _type: "image", _key: "img" },
			block("q2", "blockquote"),
		];

		const result = groupBlockquoteRuns(input);

		expect(result).toEqual(input);
	});
});
