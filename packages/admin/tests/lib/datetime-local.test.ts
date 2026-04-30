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

	it("strips seconds/ms/Z from full ISO 8601", () => {
		expect(toDatetimeLocalInputValue("2026-02-26T09:30:00.000Z")).toBe("2026-02-26T09:30");
	});

	it("pads date-only values to UTC midnight", () => {
		expect(toDatetimeLocalInputValue("2026-02-26")).toBe("2026-02-26T00:00");
	});

	it("preserves a value already in datetime-local shape", () => {
		expect(toDatetimeLocalInputValue("2026-02-26T09:30")).toBe("2026-02-26T09:30");
	});
});

describe("fromDatetimeLocalInputValue", () => {
	it("returns empty for empty input", () => {
		expect(fromDatetimeLocalInputValue("")).toBe("");
	});

	it("appends seconds/ms/Z so the value matches the validator's ISO shape", () => {
		expect(fromDatetimeLocalInputValue("2026-02-26T09:30")).toBe("2026-02-26T09:30:00.000Z");
	});

	it("round-trips a stored ISO value without drift", () => {
		const stored = "2026-02-26T09:30:00.000Z";
		expect(fromDatetimeLocalInputValue(toDatetimeLocalInputValue(stored))).toBe(stored);
	});
});
