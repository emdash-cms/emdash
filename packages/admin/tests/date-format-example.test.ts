import { describe, expect, it } from "vitest";

import { DEFAULT_DATE_FORMAT, formatDateFormatExample } from "../src/lib/date-format-example";

describe("formatDateFormatExample", () => {
	it("formats the default date format example", () => {
		expect(formatDateFormatExample(DEFAULT_DATE_FORMAT)).toBe("January 23, 2026");
	});

	it("formats ISO-style date format examples", () => {
		expect(formatDateFormatExample("yyyy-MM-dd")).toBe("2026-01-23");
	});

	it("returns null for invalid date formats", () => {
		expect(formatDateFormatExample("yyyy-MM-dd nope")).toBeNull();
	});
});
