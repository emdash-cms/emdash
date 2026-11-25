import { describe, expect, it } from "vitest";

import { cssColor, cssLength, cssOpacity } from "../../../src/utils/css-value.js";

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
			"accent-1",
			"var(--wp--preset--color--accent)",
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
		expect(cssColor("transparent;outline:1px solid red")).toBeUndefined();
		expect(cssColor("#336699;outline:0")).toBeUndefined();
		expect(cssColor("rgb(0,0,0);outline:1px solid red")).toBeUndefined();
		expect(cssColor("red !important")).toBeUndefined();
		expect(cssColor("red\n;outline:1px solid red")).toBeUndefined();
		expect(cssColor("vivid-red;outline:1px solid red")).toBeUndefined();
	});

	it("drops functions other than a single var() reference", () => {
		expect(cssColor("var(--accent, red)")).toBeUndefined();
		expect(cssColor("var(--accent);outline:1px solid red")).toBeUndefined();
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
		for (const length of [
			"0",
			"300px",
			"50vh",
			"12.5rem",
			"33.33%",
			"80dvh",
			"var(--hero-height)",
		]) {
			expect(cssLength(length)).toBe(length);
		}
	});

	it("drops a value that continues past the length", () => {
		expect(cssLength("300px;outline:1px solid red")).toBeUndefined();
		expect(cssLength("50%;outline:1px solid red")).toBeUndefined();
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

describe("cssOpacity", () => {
	it("keeps numbers and numeric strings", () => {
		expect(cssOpacity(0.3)).toBe(0.3);
		expect(cssOpacity("0.3")).toBe(0.3);
		expect(cssOpacity(".5")).toBe(0.5);
		expect(cssOpacity("1")).toBe(1);
	});

	it("clamps values outside 0 to 1", () => {
		expect(cssOpacity(1.5)).toBe(1);
		expect(cssOpacity(-1)).toBe(0);
		expect(cssOpacity("2")).toBe(1);
	});

	it("drops values that are not a single number", () => {
		expect(cssOpacity("")).toBeUndefined();
		expect(cssOpacity("0.3;outline:1px solid red")).toBeUndefined();
		expect(cssOpacity("0x1")).toBeUndefined();
		expect(cssOpacity(Number.NaN)).toBeUndefined();
		expect(cssOpacity(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(cssOpacity(null)).toBeUndefined();
	});
});
