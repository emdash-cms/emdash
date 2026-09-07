import { describe, expect, it } from "vitest";

import {
	formatPublishingInstant,
	formatPublishingInstantWithZone,
	getPublishingTimeZone,
	publishingFieldsMatchInstant,
	publishingInstantToLocalFields,
	resolvePublishingLocalDateTime,
	serializeFuturePublishingDateTime,
} from "../../src/lib/publishing-datetime.js";

describe("publishing date-time helpers", () => {
	it("round-trips an instant through browser-local minute fields", () => {
		const fields = publishingInstantToLocalFields("2026-07-01T13:30:00.000Z");

		expect(fields.date).toBeInstanceOf(Date);
		expect(fields.date?.getFullYear()).toBe(2026);
		expect(fields.date?.getMonth()).toBe(6);
		expect(fields.date?.getDate()).toBe(1);
		expect(fields.time).toBe("09:30");
		expect(
			serializeFuturePublishingDateTime(
				fields.date,
				fields.time,
				new Date("2026-07-01T12:00:00.000Z"),
			),
		).toEqual({
			success: true,
			date: new Date("2026-07-01T13:30:00.000Z"),
			value: "2026-07-01T13:30:00.000Z",
		});
	});

	it("rejects a local time skipped by daylight saving", () => {
		const result = serializeFuturePublishingDateTime(
			new Date(2026, 2, 8, 12),
			"02:30",
			new Date("2026-03-01T00:00:00.000Z"),
		);

		expect(result).toEqual({ success: false, error: "nonexistent-time" });
	});

	it("rejects a resolved instant that is not in the future", () => {
		const result = serializeFuturePublishingDateTime(
			new Date(2026, 6, 1, 12),
			"09:30",
			new Date("2026-07-01T13:30:00.000Z"),
		);

		expect(result).toEqual({ success: false, error: "past" });
	});

	it("uses the earlier offset for a repeated fall-back time", () => {
		const result = resolvePublishingLocalDateTime(new Date(2026, 10, 1, 12), "01:30");

		expect(result).toEqual({
			success: true,
			date: new Date("2026-11-01T05:30:00.000Z"),
			value: "2026-11-01T05:30:00.000Z",
		});
		expect(result.success && getPublishingTimeZone(result.date, "en-US").shortName).toBe("EDT");
	});

	it("compares persisted values at the UI's minute precision", () => {
		const fields = publishingInstantToLocalFields("2026-07-01T13:30:45.123Z");

		expect(publishingFieldsMatchInstant("2026-07-01T13:30:45.123Z", fields.date, fields.time)).toBe(
			true,
		);
	});

	it("formats the instant and reports the browser time zone", () => {
		expect(formatPublishingInstant("2026-07-01T13:30:00.000Z", "en-US")).toContain("9:30 AM");
		expect(formatPublishingInstantWithZone("2026-07-01T13:30:00.000Z", "en-US")).toContain(
			"9:30 AM (EDT)",
		);
		expect(getPublishingTimeZone(new Date("2026-07-01T13:30:00.000Z"), "en-US")).toEqual({
			timeZone: "America/New_York",
			shortName: "EDT",
		});
	});
});
