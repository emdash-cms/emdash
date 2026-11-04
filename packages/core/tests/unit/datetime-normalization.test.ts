import { describe, expect, it } from "vitest";

import {
	DatetimeNormalizationError,
	normalizeDatetime,
	normalizeContentDatetimes,
} from "../../src/datetime-normalization.js";

describe("datetime normalization", () => {
	it("canonicalizes offset-bearing values without changing the instant", () => {
		const normalized = normalizeDatetime("2026-08-22T01:00:00+09:00", "UTC");

		expect(normalized).toEqual({
			value: "2026-08-21T16:00:00.000Z",
			kind: "offset",
		});
	});

	it("rejects semantically invalid offset-bearing values", () => {
		expect(() => normalizeDatetime("2026-02-30T09:00:00Z", "UTC")).toThrowError(
			DatetimeNormalizationError,
		);
	});

	it("repairs legacy JSON-quoted Date values", () => {
		expect(normalizeDatetime('"2026-08-21T16:00:00.000Z"', "UTC")).toEqual({
			value: "2026-08-21T16:00:00.000Z",
			kind: "offset",
		});
	});

	it("resolves naive and date-only values in the configured site timezone", () => {
		expect(normalizeDatetime("2026-01-15T09:30", "America/New_York")).toEqual({
			value: "2026-01-15T14:30:00.000Z",
			kind: "naive",
		});
		expect(normalizeDatetime("2026-08-22", "Asia/Tokyo")).toEqual({
			value: "2026-08-21T15:00:00.000Z",
			kind: "naive",
		});
	});

	it.each([
		["ambiguous", "2026-11-01T01:30"],
		["nonexistent", "2026-03-08T02:30"],
	] as const)("rejects %s local times for manual review", (code, value) => {
		expect(() => normalizeDatetime(value, "America/New_York")).toThrowError(
			expect.objectContaining<Partial<DatetimeNormalizationError>>({ code }),
		);
	});

	it("normalizes top-level and repeater datetime fields without touching ordinary strings", () => {
		const normalized = normalizeContentDatetimes(
			{
				title: "2026-01-15T09:30",
				starts_at: "2026-01-15T09:30",
				sessions: [{ label: "Opening", begins_at: "2026-01-15T10:00" }],
			},
			[
				{ slug: "starts_at", type: "datetime" },
				{ slug: "sessions", type: "repeater", datetimeSubFields: ["begins_at"] },
			],
			"Europe/London",
		);

		expect(normalized.value).toEqual({
			title: "2026-01-15T09:30",
			starts_at: "2026-01-15T09:30:00.000Z",
			sessions: [{ label: "Opening", begins_at: "2026-01-15T10:00:00.000Z" }],
		});
		expect(normalized.naiveCount).toBe(2);
	});
});
