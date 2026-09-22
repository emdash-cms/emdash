import { afterEach, describe, it, expect, vi } from "vitest";

import {
	cn,
	formatDate,
	formatRelativeTime,
	isolate,
	parseTimestamp,
	slugify,
} from "../../src/lib/utils";

describe("slugify", () => {
	it("converts basic text to slug", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it.each([
		["مرحبا بالعالم", "مرحبا-بالعالم"],
		["你好世界", "你好世界"],
		["日本 語", "日本-語"],
		["한국어 제목", "한국어-제목"],
		["Привет мир", "привет-мир"],
		["שלום עולם", "שלום-עולם"],
		["สวัสดี โลก", "สวัสดี-โลก"],
		["Καλημέρα κόσμε", "καλημέρα-κόσμε"],
		["మేష రాసి", "మేష-రాసి"],
	])("preserves Unicode letters, numbers, and marks in %s", (input, expected) => {
		expect(slugify(input)).toBe(expected);
	});

	it("normalizes compatibility characters and canonically equivalent marks", () => {
		expect(slugify("Ｃａｆｅ\u0301＿２０２６")).toBe("café-2026");
	});

	it("strips special characters", () => {
		expect(slugify("hello! @world# $")).toBe("hello-world");
	});

	it("collapses multiple hyphens", () => {
		expect(slugify("hello---world")).toBe("hello-world");
	});

	it("trims leading/trailing hyphens", () => {
		expect(slugify("-hello-world-")).toBe("hello-world");
	});

	it("handles underscores as separators", () => {
		expect(slugify("hello_world")).toBe("hello-world");
	});

	it("uses a deterministic fallback when no usable characters remain", () => {
		const emojiSlug = slugify("😀😀");
		expect(emojiSlug).toMatch(/^untitled-[a-z0-9]+$/);
		expect(slugify("😀😀")).toBe(emojiSlug);
		expect(slugify("🎉")).not.toBe(emojiSlug);
		expect(slugify("")).toMatch(/^untitled-[a-z0-9]+$/);
		expect(slugify("!@#$%")).toMatch(/^untitled-[a-z0-9]+$/);
	});

	it("handles mixed case", () => {
		expect(slugify("HeLLo WoRLD")).toBe("hello-world");
	});

	it("handles multiple spaces", () => {
		expect(slugify("hello   world")).toBe("hello-world");
	});

	it("truncates by grapheme without splitting a combined character", () => {
		expect(slugify("क्षक्ष", 1)).toBe("क्ष");
	});
});

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("foo", "bar")).toBe("foo bar");
	});

	it("handles conditional classes", () => {
		const condition = false;
		expect(cn("foo", condition && "bar", "baz")).toBe("foo baz");
	});

	it("merges conflicting tailwind classes", () => {
		expect(cn("p-4", "p-2")).toBe("p-2");
	});

	it("handles undefined and null", () => {
		expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
	});
});

describe("parseTimestamp", () => {
	it("treats a SQLite datetime('now') value as UTC", () => {
		expect(parseTimestamp("2026-05-03 17:26:23").toISOString()).toBe("2026-05-03T17:26:23.000Z");
	});

	it("leaves a value with a Z designator unchanged", () => {
		expect(parseTimestamp("2026-05-03T17:26:23.000Z").toISOString()).toBe(
			"2026-05-03T17:26:23.000Z",
		);
	});

	it("leaves a value with a lowercase z designator unchanged", () => {
		expect(parseTimestamp("2026-05-03T17:26:23z").toISOString()).toBe("2026-05-03T17:26:23.000Z");
	});

	it("respects an explicit UTC offset", () => {
		expect(parseTimestamp("2026-05-03T17:26:23+02:00").toISOString()).toBe(
			"2026-05-03T15:26:23.000Z",
		);
	});

	it("treats a Postgres hour-only offset as already zoned", () => {
		expect(parseTimestamp("2026-05-03 17:26:23+00").toISOString()).toBe("2026-05-03T17:26:23.000Z");
	});
});

describe("formatRelativeTime", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function at(now: string) {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(now));
	}

	it("writes the phrase in the admin's locale, not English", () => {
		at("2026-09-22T12:30:00Z");
		expect(formatRelativeTime("2026-09-22T12:27:00Z", "he")).toBe("לפני 3 דקות");
		expect(formatRelativeTime("2026-09-22T12:27:00Z", "de")).toBe("vor 3 Minuten");
		expect(formatRelativeTime("2026-09-22T12:27:00Z", "en")).toBe("3 minutes ago");
	});

	it("counts in minutes, hours and days", () => {
		at("2026-09-22T12:00:00Z");
		expect(formatRelativeTime("2026-09-22T11:59:30Z", "en")).toBe("now");
		expect(formatRelativeTime("2026-09-22T10:00:00Z", "en")).toBe("2 hours ago");
		expect(formatRelativeTime("2026-09-20T12:00:00Z", "en")).toBe("2 days ago");
	});

	it("falls back to a date once a week has passed", () => {
		at("2026-09-22T12:00:00Z");
		expect(formatRelativeTime("2026-08-01T12:00:00Z", "en")).toBe("Aug 1");
	});

	it("reads a SQLite timestamp as UTC", () => {
		at("2026-09-22T12:30:00Z");
		expect(formatRelativeTime("2026-09-22 12:00:00", "en")).toBe("30 minutes ago");
	});
});

describe("formatDate", () => {
	it("formats in the given locale rather than the browser's", () => {
		expect(
			formatDate("2026-09-22T19:48:00Z", "en-GB", { dateStyle: "medium", timeZone: "UTC" }),
		).toBe("22 Sept 2026");
		expect(formatDate("2026-09-22T19:48:00Z", "de", { dateStyle: "medium", timeZone: "UTC" })).toBe(
			"22.09.2026",
		);
	});

	it("accepts a Date as well as a timestamp string", () => {
		const date = new Date("2026-09-22T19:48:00Z");
		expect(formatDate(date, "en-GB", { dateStyle: "short", timeZone: "UTC" })).toBe("22/09/2026");
	});
});

describe("isolate", () => {
	it("wraps the value in first-strong isolate characters", () => {
		expect(isolate("22 Sept 2026, 22:48")).toBe("\u206822 Sept 2026, 22:48\u2069");
	});

	it("keeps a date whole inside a right-to-left sentence", () => {
		// Without the isolates the comma between the two numbers takes the sentence's direction.
		const sentence = `נוצר ${isolate("22 בספט׳ 2026, 22:48")}`;
		expect(sentence).toContain("\u2068");
		expect(sentence.endsWith("\u2069")).toBe(true);
	});
});
