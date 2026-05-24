import { describe, expect, it } from "vitest";

import { getReadingTime } from "../../../../../templates/blog/src/utils/reading-time";

function makeContent(text: string) {
	return [
		{
			_type: "block",
			children: [{ _type: "span", text }],
		},
	];
}

describe("blog template reading time", () => {
	it("keeps word-based reading time for English content", () => {
		expect(getReadingTime(makeContent("word ".repeat(200)))).toBe(1);
	});

	it("counts CJK content by character length", () => {
		expect(getReadingTime(makeContent("日".repeat(2000)))).toBe(4);
	});

	it("adds English words and CJK characters for mixed-language posts", () => {
		expect(getReadingTime(makeContent(`${"word ".repeat(100)}${"日".repeat(500)}`))).toBe(2);
	});
});
