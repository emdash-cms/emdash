import { describe, it, expect } from "vitest";

import { remapNestingBlocks } from "../../../src/components/portable-text-nesting.js";

describe("remapNestingBlocks (render adaptation)", () => {
	it("remaps nestingBlock and its columns' `children` to `content`", () => {
		const input = [
			{ _type: "block", _key: "p1", children: [{ _type: "span", _key: "s", text: "hi" }] },
			{
				_type: "nestingBlock",
				_key: "n1",
				layout: "grid",
				columns: 2,
				children: [
					{
						_type: "nestingColumn",
						_key: "c1",
						children: [
							{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "a" }] },
						],
					},
				],
			},
		];

		const out = remapNestingBlocks(input) as Array<Record<string, unknown>>;

		// Regular block keeps reserved `children` (spans).
		expect("content" in out[0]).toBe(false);
		expect(out[0].children).toBeDefined();

		// Container: children -> content (columns).
		expect("children" in out[1]).toBe(false);
		const cols = out[1].content as Array<Record<string, unknown>>;
		expect(cols).toHaveLength(1);

		// Column: children -> content (blocks).
		expect(cols[0]._type).toBe("nestingColumn");
		expect("children" in cols[0]).toBe(false);
		expect(Array.isArray(cols[0].content)).toBe(true);
	});

	it("wraps legacy loose blocks under a nesting block into columns", () => {
		const input = [
			{
				_type: "nestingBlock",
				_key: "n",
				children: [{ _type: "block", _key: "b", children: [] }],
			},
		];
		const out = remapNestingBlocks(input) as Array<Record<string, unknown>>;
		const cols = out[0].content as Array<Record<string, unknown>>;
		expect(cols[0]._type).toBe("nestingColumn");
		expect(Array.isArray(cols[0].content)).toBe(true);
	});
});
