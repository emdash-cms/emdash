import { describe, expect, it } from "vitest";

import { cssColor, cssLength } from "../../../src/utils/css-value.js";

describe("cssColor", () => {
	it("keeps the color an upload's placeholder is stored as", () => {
		expect(cssColor("rgb(51,102,153)")).toBe("rgb(51,102,153)");
	});

	it("keeps hex, keyword and functional colors", () => {
		for (const color of [
			"#369",
			"#3369",
			"#336699",
			"#336699cc",
			"rebeccapurple",
			"vivid-red",
			"transparent",
			"rgba(0, 0, 0, 0.5)",
			"rgb(0 0 0 / 50%)",
			"hsl(210deg 50% 40%)",
			"oklch(60% 0.15 250)",
			"color(display-p3 0.2 0.4 0.6)",
		]) {
			expect(cssColor(color)).toBe(color);
		}
	});

	it("drops a value that continues past the color", () => {
		expect(cssColor("transparent;position:fixed;inset:0")).toBeUndefined();
		expect(cssColor("#336699;opacity:0")).toBeUndefined();
		expect(cssColor("rgb(0,0,0);position:fixed")).toBeUndefined();
		expect(cssColor("red !important")).toBeUndefined();
		expect(cssColor("red\n;position:fixed")).toBeUndefined();
		expect(cssColor("vivid-red;position:fixed")).toBeUndefined();
	});

	it("drops functions that can reference other values", () => {
		expect(cssColor("var(--accent)")).toBeUndefined();
		expect(cssColor("url(https://example.com/a.png)")).toBeUndefined();
		expect(cssColor("rgb(var(--r), 0, 0)")).toBeUndefined();
	});

	it("drops values that are not colors", () => {
		expect(cssColor("")).toBeUndefined();
		expect(cssColor("#12")).toBeUndefined();
		expect(cssColor(0x336699)).toBeUndefined();
		expect(cssColor(null)).toBeUndefined();
		expect(cssColor(undefined)).toBeUndefined();
	});
});

describe("cssLength", () => {
	it("keeps lengths and percentages", () => {
		for (const length of ["0", "300px", "50vh", "12.5rem", "33.33%", "80dvh"]) {
			expect(cssLength(length)).toBe(length);
		}
	});

	it("drops a value that continues past the length", () => {
		expect(cssLength("300px;position:fixed;inset:0")).toBeUndefined();
		expect(cssLength("50%;background:url(https://example.com/a.png)")).toBeUndefined();
		expect(cssLength("300px !important")).toBeUndefined();
	});

	it("drops values that are not a single length", () => {
		expect(cssLength("")).toBeUndefined();
		expect(cssLength("px")).toBeUndefined();
		expect(cssLength("300")).toBeUndefined();
		expect(cssLength("-10px")).toBeUndefined();
		expect(cssLength("calc(100% - 1px)")).toBeUndefined();
		expect(cssLength(300)).toBeUndefined();
		expect(cssLength(undefined)).toBeUndefined();
	});
});
