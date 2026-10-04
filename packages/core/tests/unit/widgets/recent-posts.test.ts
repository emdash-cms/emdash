import { describe, expect, it } from "vitest";

import {
	createPublishedDateFormatter,
	isThumbnailImage,
	toPublishedDate,
} from "../../../src/widgets/recent-posts.js";

describe("toPublishedDate", () => {
	it("accepts Date objects returned by getEmDashCollection", () => {
		const date = new Date("2026-10-01T12:00:00.000Z");
		expect(toPublishedDate(date)).toEqual(date);
	});

	it("accepts ISO date strings", () => {
		expect(toPublishedDate("2026-10-01T12:00:00.000Z")).toEqual(
			new Date("2026-10-01T12:00:00.000Z"),
		);
	});

	it("returns null for invalid, missing, and non-date values", () => {
		expect(toPublishedDate(null)).toBeNull();
		expect(toPublishedDate(undefined)).toBeNull();
		expect(toPublishedDate("")).toBeNull();
		expect(toPublishedDate("not-a-date")).toBeNull();
		expect(toPublishedDate(new Date(Number.NaN))).toBeNull();
		expect(toPublishedDate({})).toBeNull();
	});
});

describe("createPublishedDateFormatter", () => {
	const lateSeptember30Utc = new Date("2026-09-30T20:00:00.000Z");
	const earlyOctober1Utc = new Date("2026-10-01T02:00:00.000Z");

	it("formats the date in the configured timezone", () => {
		const tokyo = createPublishedDateFormatter({ timezone: "Asia/Tokyo" });
		const pagoPago = createPublishedDateFormatter({ timezone: "Pacific/Pago_Pago" });

		expect(tokyo.format(lateSeptember30Utc)).toBe("October 1, 2026");
		expect(pagoPago.format(earlyOctober1Utc)).toBe("September 30, 2026");
	});

	it("uses UTC when no timezone is configured", () => {
		const formatter = createPublishedDateFormatter();

		expect(formatter.format(lateSeptember30Utc)).toBe("September 30, 2026");
	});

	it("falls back to UTC when the timezone is not recognized", () => {
		const formatter = createPublishedDateFormatter({ timezone: "Mars/Olympus_Mons" });

		expect(formatter.format(lateSeptember30Utc)).toBe("September 30, 2026");
	});

	it("formats the date for the given locale", () => {
		const date = new Date("2026-10-01T12:00:00.000Z");

		expect(createPublishedDateFormatter({ locale: "fr" }).format(date)).toBe("1 octobre 2026");
		expect(createPublishedDateFormatter({ locale: "en-GB" }).format(date)).toBe("1 October 2026");
	});

	it("falls back to English when the locale is not a valid language tag", () => {
		const date = new Date("2026-10-01T12:00:00.000Z");

		expect(createPublishedDateFormatter({ locale: "en_US" }).format(date)).toBe("October 1, 2026");
	});
});

describe("isThumbnailImage", () => {
	it("accepts media values and image URLs", () => {
		expect(
			isThumbnailImage({ id: "01J8K", provider: "local", meta: { storageKey: "featured.jpg" } }),
		).toBe(true);
		expect(isThumbnailImage("https://example.com/photo.jpg")).toBe(true);
	});

	it("rejects missing and malformed values", () => {
		expect(isThumbnailImage(null)).toBe(false);
		expect(isThumbnailImage(undefined)).toBe(false);
		expect(isThumbnailImage("")).toBe(false);
		expect(isThumbnailImage(123)).toBe(false);
		expect(isThumbnailImage({ src: "https://example.com/photo.jpg" })).toBe(false);
	});
});
