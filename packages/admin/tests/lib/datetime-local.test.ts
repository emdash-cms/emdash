import { describe, expect, it } from "vitest";

import {
	fromDatetimeLocalInputValue,
	toDatetimeLocalInputValue,
} from "../../src/lib/datetime-local";

describe("toDatetimeLocalInputValue", () => {
	it("returns empty for non-string and empty values", () => {
		expect(toDatetimeLocalInputValue(undefined)).toBe("");
		expect(toDatetimeLocalInputValue(null)).toBe("");
		expect(toDatetimeLocalInputValue(0)).toBe("");
		expect(toDatetimeLocalInputValue("")).toBe("");
	});

	it("displays a stored instant in the configured site timezone", () => {
		expect(toDatetimeLocalInputValue("2026-02-26T09:30:00.000Z", "Asia/Tokyo")).toBe(
			"2026-02-26T18:30",
		);
	});

	it("keeps legacy naive values readable without applying the browser timezone", () => {
		expect(toDatetimeLocalInputValue("2026-02-26T09:30", "Asia/Tokyo")).toBe("2026-02-26T09:30");
		expect(toDatetimeLocalInputValue("2026-02-26", "Asia/Tokyo")).toBe("2026-02-26T00:00");
	});

	it("preserves a value already in datetime-local shape", () => {
		expect(toDatetimeLocalInputValue("2026-02-26T09:30")).toBe("2026-02-26T09:30");
	});
});

describe("fromDatetimeLocalInputValue", () => {
	it("returns empty for empty input", () => {
		expect(fromDatetimeLocalInputValue("")).toBe("");
	});

	it("converts site-local input to a canonical UTC instant", () => {
		expect(fromDatetimeLocalInputValue("2026-02-26T09:30", "Asia/Tokyo")).toBe(
			"2026-02-26T00:30:00.000Z",
		);
	});

	it("round-trips a stored ISO value without drift", () => {
		const stored = "2026-02-26T09:30:00.000Z";
		expect(
			fromDatetimeLocalInputValue(
				toDatetimeLocalInputValue(stored, "America/New_York"),
				"America/New_York",
			),
		).toBe(stored);
	});

	it.each(["2026-11-01T01:30", "2026-03-08T02:30"])(
		"refuses ambiguous or nonexistent site-local input: %s",
		(value) => {
			expect(() => fromDatetimeLocalInputValue(value, "America/New_York")).toThrow();
		},
	);
});
